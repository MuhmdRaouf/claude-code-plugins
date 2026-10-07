import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Priority } from "../domain/brief.ts";
import { parseJson } from "../domain/json.ts";
import { stateLayout } from "../domain/state-layout.ts";
import type { Semaphore } from "../ports/index.ts";
import { errnoCode } from "./fs-errors.ts";
import {
  createExclusive,
  createHolding,
  type IsAlive,
  type Release,
  readHolder,
  release,
  waitLock,
} from "./fs-lock.ts";

/** The fields a ticket body must carry to be a ticket; anything else is nobody's. */
const TicketBody = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  priority: z.enum(["high", "normal"]),
  queuedAt: z.number(),
});

const POLL_MS = 2000;
/** The mutex is held only to count and create slots and tickets; this long means its holder is stuck, so retry next poll. */
const MUTEX_TIMEOUT_MS = 10_000;
const SLOT = ".slot";
const TICKET = ".ticket";
/** Waiting order: the higher priority first, then the older ticket. */
const RANK: Record<Priority, number> = { high: 1, normal: 0 };

interface Slot {
  readonly jobId: string;
  readonly pid: number | null;
}

interface Ticket {
  readonly jobId: string;
  readonly pid: number | null;
  readonly priority: Priority;
  readonly queuedAt: number;
}

/** A job asking for a slot: itself, and where it sits in the waiting order. */
interface Holder {
  readonly jobId: string;
  readonly pid: number;
  readonly priority: Priority;
}

/** A ticket whose writer is still around to take the slot when its turn comes. */
interface LiveTicket {
  readonly jobId: string;
  readonly pid: number;
  readonly priority: Priority;
  readonly queuedAt: number;
}

type Now = () => number;
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** <root>/slots/<jobId>.slot created exclusively (complete with its pid, or not at all); stale holders (dead pid) are
 *  reclaimed; polls every 2 s. A job waiting for a slot leaves <jobId>.ticket (its pid, priority and enqueue time)
 *  under the same mutex, so a freed slot goes to the oldest live ticket of the higher priority — a dead waiter's
 *  ticket is reclaimed like a dead holder's slot.
 *  Counting and creating slots and tickets happen under one mutex file, so processes racing for the last slot cannot
 *  both win. */
export function createFsSemaphore(
  root: string,
  capacity: () => Promise<number>,
  isAlive: IsAlive,
  sleep: Sleep,
  now: Now,
): Semaphore {
  const dir = stateLayout(root).slots;
  const slotPath = (jobId: string) => join(dir, `${jobId}${SLOT}`);
  const ticketPath = (jobId: string) => join(dir, `${jobId}${TICKET}`);
  const live = (slot: Slot): slot is { readonly jobId: string; readonly pid: number } =>
    slot.pid !== null && isAlive(slot.pid);
  const waiting = (ticket: Ticket): ticket is LiveTicket => ticket.pid !== null && isAlive(ticket.pid);

  async function slots(): Promise<Slot[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return [];
      throw error;
    }
    const found = await Promise.all(
      names
        .filter((name) => name.endsWith(SLOT))
        .sort()
        .map(async (name) => ({
          jobId: name.slice(0, -SLOT.length),
          pid: await readHolder(join(dir, name)),
        })),
    );
    // undefined: released between readdir and read.
    return found.flatMap(({ jobId, pid }) => (pid === undefined ? [] : [{ jobId, pid }]));
  }

  /** A ticket we cannot read as one of ours is nobody's, exactly like a slot file nobody holds. */
  function parseTicket(jobId: string, text: string): Ticket {
    const body = parseJson(text, TicketBody);
    return body === undefined ? { jobId, pid: null, priority: "normal", queuedAt: 0 } : { jobId, ...body };
  }

  async function tickets(): Promise<Ticket[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return [];
      throw error;
    }
    const found = await Promise.all(
      names
        .filter((name) => name.endsWith(TICKET))
        .sort()
        .map(async (name) => {
          let text: string;
          try {
            text = await readFile(join(dir, name), "utf8");
          } catch (error) {
            if (errnoCode(error) === "ENOENT") return undefined;
            throw error;
          }
          return parseTicket(name.slice(0, -TICKET.length), text);
        }),
    );
    // undefined: removed between readdir and read.
    return found.flatMap((ticket) => (ticket === undefined ? [] : [ticket]));
  }

  /** Higher priority first, then the older ticket; the jobId breaks a tie so every waiter ranks the queue the same. */
  const byTurn = (a: Ticket, b: Ticket): number =>
    RANK[b.priority] - RANK[a.priority] || a.queuedAt - b.queuedAt || (a.jobId < b.jobId ? -1 : 1);

  /** Dead holders' slots and dead waiters' tickets go back to the pool for whoever waits next. */
  async function reclaim(current: readonly Slot[], queued: readonly Ticket[]): Promise<void> {
    for (const slot of current.filter((stale) => !live(stale)))
      await rm(slotPath(slot.jobId), { force: true });
    for (const ticket of queued.filter((stale) => !waiting(stale)))
      await rm(ticketPath(ticket.jobId), { force: true });
  }

  /** Our ticket: the live one a previous round left, or a fresh one stamped with when we started waiting. */
  async function queueTicket(queued: readonly Ticket[], holder: Holder): Promise<Ticket | null> {
    const mine = queued.find((ticket) => waiting(ticket) && ticket.jobId === holder.jobId);
    if (mine !== undefined) return mine;
    const text = JSON.stringify({ pid: holder.pid, priority: holder.priority, queuedAt: now() });
    return (await createExclusive(ticketPath(holder.jobId), text)) ? parseTicket(holder.jobId, text) : null;
  }

  /** A slot is ours to take when one is free and the queue's next turn is ours: a freed slot belongs to the oldest
   *  live ticket of the higher priority, and only its own round grants it. */
  async function ourTurn(
    current: readonly Slot[],
    queued: readonly Ticket[],
    mine: Ticket,
    jobId: string,
  ): Promise<boolean> {
    if (current.filter(live).length >= (await capacity())) return false;
    const next = [...queued.filter((ticket) => waiting(ticket) && ticket.jobId !== jobId), mine].sort(
      byTurn,
    )[0];
    return next?.jobId === jobId;
  }

  /** One round under the mutex: drop dead holders' slots and dead waiters' tickets, queue our ticket, then take a slot
   *  if the capacity allows and the next turn is ours. */
  async function tryAcquire(holder: Holder): Promise<Release | null> {
    await mkdir(dir, { recursive: true });
    const mutex = await waitLock(join(dir, ".mutex"), holder.pid, isAlive, MUTEX_TIMEOUT_MS);
    if (!mutex.ok) return null;
    try {
      const current = await slots();
      if (current.some((slot) => live(slot) && slot.jobId === holder.jobId)) return null;
      const queued = await tickets();
      await reclaim(current, queued);
      const mine = await queueTicket(queued, holder);
      if (mine === null) return null;
      if (!(await ourTurn(current, queued, mine, holder.jobId))) return null;
      if (!(await createHolding(slotPath(holder.jobId), holder.pid))) return null;
      await rm(ticketPath(holder.jobId), { force: true });
      return () => release(slotPath(holder.jobId), holder.pid);
    } finally {
      await mutex.value();
    }
  }

  return {
    async acquire(holder, signal) {
      try {
        for (;;) {
          signal?.throwIfAborted();
          const slot = await tryAcquire(holder);
          if (slot !== null) {
            if (!signal?.aborted) return slot;
            // Aborted while the round ran: give the slot straight back so an aborted acquire holds nothing.
            await slot();
            signal.throwIfAborted();
          }
          await sleep(POLL_MS, signal).catch((error: unknown) => {
            // Reject with the caller's abort reason whatever the injected sleep rejects with.
            signal?.throwIfAborted();
            throw error;
          });
        }
      } finally {
        // An acquire that gave up waiting leaves no ticket behind to keep its turn.
        await rm(ticketPath(holder.jobId), { force: true });
      }
    },
    async held() {
      return (await slots()).filter(live).map(({ jobId, pid }) => ({ jobId, pid }));
    },
  };
}
