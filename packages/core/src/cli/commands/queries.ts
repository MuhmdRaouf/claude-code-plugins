import { activityBoard, jobRows, routerHealth, usageEvents, usageWindows } from "../../app/activity.ts";
import { modelAdvice } from "../../app/advisor.ts";
import type { BoardRow } from "../../app/queries.ts";
import { board, engineUsage, jobRow, reviewPacket, usage } from "../../app/queries.ts";
import type { JobState } from "../../domain/job.ts";
import { progressText } from "../../render/format.ts";
import {
  renderBoard,
  renderHook,
  renderJob,
  renderReview,
  renderReviewSummary,
  renderUsage,
} from "../../render/index.ts";
import { costUsdOf, PRICES_RETRIEVED } from "../../render/prices.ts";
import { adviceWorthShowing, advisorSaving, windowCosts } from "../../render/usage.ts";
import {
  type AgentStopInput,
  agentRun,
  agentStopMessage,
  modelAgentOf,
  readStdinWithin,
  readTail,
  transcriptPathOf,
} from "../agent-hook.ts";
import type { Command, Invocation } from "../command.ts";
import { EXIT, type ExitCode } from "../exit.ts";
import { untilInterrupted } from "../interrupt.ts";
import { readSetupDone, userMessage } from "../route.ts";
import { repoOf } from "../scope.ts";

const MAX_DIFF_CHARS = 60_000;
const FOLLOW_POLL_MS = 2000;
const WATCH_POLL_MS = 2000;
const ACTIVE: ReadonlySet<JobState> = new Set<JobState>(["queued", "running", "verifying"]);

export const boardCommand: Command = {
  name: "board",
  synopsis: ["board [--all] [--watch] [--json]"],
  options: { all: { type: "boolean" }, hook: { type: "boolean" }, watch: { type: "boolean" } },
  async run(call) {
    if (call.flag("hook")) return hook(call);
    if (call.flag("watch") && process.stdout.isTTY === true)
      return untilInterrupted((signal) => watchBoard(call, signal));
    return printBoard(call);
  },
};

async function printBoard(call: Invocation): Promise<ExitCode> {
  const rows = await activityBoard(call.deps, await scope(call));
  if (call.flag("json")) call.json(rows);
  else call.deps.out.line(renderBoard(call.deps.provider, rows, call.deps.clock.now()));
  return EXIT.ok;
}

/** Redraws the board every 2 s until Ctrl-C (which ends the watch, exit 0). Off a TTY `board` prints once instead. */
async function watchBoard(call: Invocation, signal: AbortSignal): Promise<ExitCode> {
  for (;;) {
    await printBoard(call);
    try {
      await call.deps.clock.sleep(WATCH_POLL_MS, signal);
    } catch (error) {
      if (signal.aborted) return EXIT.ok;
      throw error;
    }
  }
}

async function scope(call: Invocation): Promise<{ readonly repoRoot?: string; readonly all: boolean }> {
  const repoRoot = await repoOf(call.deps, call.cwd);
  return { ...(repoRoot === undefined ? {} : { repoRoot }), all: call.flag("all") };
}

/** The SessionStart hook: one line or nothing, never an error, always exit 0. */
async function hook(call: Invocation): Promise<ExitCode> {
  try {
    const line = renderHook(
      call.deps.provider,
      jobRows(call.deps.provider, await board(call.deps, await scope(call))),
    );
    if (line !== "") call.deps.out.line(line);
  } catch {
    // A hook must never disturb the session it starts.
  }
  return EXIT.ok;
}

export const showCommand: Command = {
  name: "show",
  synopsis: ["show <id> [--follow] [--json]"],
  options: { follow: { type: "boolean" } },
  async run(call) {
    const [id] = call.positionals;
    if (id === undefined) return call.usage("show needs a job id");
    const found = await jobRow(call.deps, id);
    if (!found.ok) return call.fail(found.error);
    const row = call.flag("follow") ? await follow(call, found.value) : found.value;
    if (call.flag("json")) call.json(row);
    else call.deps.out.line(renderJob(call.deps.provider, row, call.deps.clock.now()));
    return EXIT.ok;
  },
};

/** One line per change of state or progress while a live driver works the job; returns the settled row. */
async function follow(call: Invocation, first: BoardRow): Promise<BoardRow> {
  let row = first;
  let shown = "";
  while (ACTIVE.has(row.job.state) && row.live) {
    const line =
      row.progress === undefined ? row.job.state : `${row.job.state} · ${progressText(row.progress)}`;
    if (line !== shown && !call.flag("json")) call.deps.out.line(line);
    shown = line;
    await call.deps.clock.sleep(FOLLOW_POLL_MS);
    const next = await jobRow(call.deps, row.job.id);
    if (!next.ok) return row;
    row = next.value;
  }
  return row;
}

export const reviewCommand: Command = {
  name: "review",
  synopsis: ["review <id> [--diff] [--summary] [--json]"],
  options: { diff: { type: "boolean" }, summary: { type: "boolean" } },
  async run(call) {
    const [id] = call.positionals;
    if (id === undefined) return call.usage("review needs a job id");
    if (call.flag("diff") && call.flag("summary"))
      return call.usage("--diff and --summary exclude each other");
    const packet = await reviewPacket(call.deps, id, {
      diff: call.flag("diff"),
      maxDiffChars: MAX_DIFF_CHARS,
    });
    if (!packet.ok) return call.fail(packet.error);
    const { provider } = call.deps;
    if (call.flag("json")) call.json(packet.value);
    else if (call.flag("summary")) call.deps.out.line(renderReviewSummary(provider, packet.value));
    else call.deps.out.line(renderReview(provider, packet.value));
    return EXIT.ok;
  },
};

/** How long the SubagentStop hook waits for its input; the whole hook stays well under a second. */
const HOOK_STDIN_MS = 300;

export const usageCommand: Command = {
  name: "usage",
  synopsis: ["usage [--json]"],
  options: { hook: { type: "boolean" } },
  async run(call) {
    if (call.flag("hook")) return agentStopHook(call, await readStdinWithin(HOOK_STDIN_MS));
    const events = usageEvents(call.deps);
    const windows = usageWindows(call.deps, events);
    const jobs = await usage(call.deps, await scope(call));
    const engines = await engineUsage(call.deps, await scope(call));
    const allJobs = await call.deps.store.list();
    const health = routerHealth(call.deps, events);
    const advice = modelAdvice(call.deps, allJobs, events);
    const { provider, clock } = call.deps;
    const now = clock.now();
    if (call.flag("json"))
      call.json({
        estimate: {
          pricesRetrieved: PRICES_RETRIEVED,
          windows: windowCosts(provider, windows, allJobs, now),
        },
        spool: windows.map((window) => ({
          label: window.label,
          days: window.days,
          rows: window.rows.map((row) => ({ ...row, costUsd: costUsdOf(row.model, row) })),
        })),
        // JSON speaks the provider's tier names (zai's users read "glm", not "main").
        jobs: jobs.map((row) => ({ ...row, tier: provider.tierNames[row.tier] })),
        // Only once a delegation engine ran jobs, so a claude-only report reads as it always did.
        ...(engines.length === 0 ? {} : { engines }),
        routerHealth: health,
        // The advisor only when it has enough data to say something; an estimate, never acted on.
        ...(adviceWorthShowing(advice)
          ? { advisor: { ...advice, estSavingUsd: advisorSaving(advice) } }
          : {}),
      });
    else call.deps.out.line(renderUsage(provider, { windows, jobs, engines, allJobs, now, health, advice }));
    return EXIT.ok;
  },
};

/** The SubagentStop hook (`usage --hook`, input JSON on stdin): one `systemMessage` for the user about what a model
 *  agent ran on, or nothing. Never an error, always exit 0. */
export async function agentStopHook(call: Invocation, stdin: string): Promise<ExitCode> {
  try {
    const input = JSON.parse(stdin) as AgentStopInput;
    const { provider } = call.deps;
    const agent = modelAgentOf(provider, input);
    const path = agent === undefined ? undefined : transcriptPathOf(input);
    const text = path === undefined ? undefined : readTail(path);
    if (agent === undefined || text === undefined) return EXIT.ok;
    const message = agentStopMessage(
      provider,
      agent,
      agentRun(text),
      readSetupDone(call.deps.host.stateRoot),
    );
    if (message !== undefined) userMessage(call.deps.out, message);
  } catch {
    // A hook never disturbs the session: bad input, a missing transcript, anything, is silence.
  }
  return EXIT.ok;
}
