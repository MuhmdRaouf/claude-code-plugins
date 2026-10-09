// Board.tsx — the work Board: one column per status, the cards draggable between them, each card
// with its move menu (every other status), its gate and notes tags, who is on it, and — while the
// task waits — what it waits on. Empty Blocked and Skipped collapse to a rail. The card of the
// task whose drawer is open wears the daisyUI aura. Port of work.js COLS/paintBoard.

import { type MenuItem, PopMenu } from "@muhmdraouf/ui/menu.tsx";
import { Panel } from "@muhmdraouf/ui/page.tsx";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { Api } from "../api.ts";
import { Icon } from "../icons.tsx";
import { Avatar, StatusIcon } from "../kit.tsx";
import { FIN, STATM, type TaskStatus, who } from "../status.ts";
import type { Board, PlanStep } from "../store.ts";
import { EmptyTasks } from "./List.tsx";
import type { Step } from "./model.ts";
import { stepState, taskHref } from "./model.ts";

/** The columns, in order: to do · doing · blocked · done · skipped. */
export const COLS: readonly TaskStatus[] = ["todo", "doing", "blocked", "done", "skipped"];

/** The Board's props: the rows that pass the filters, the board around them, and the status
 *  change with its Undo. */
export type BoardProps = {
  ch: string;
  api: Api;
  board: Board;
  /** The rows that pass the filters, in board order. */
  rows: readonly Step[];
  /** Which sessions sit on which task right now. */
  on: Map<string, string[]>;
  /** The rows changed since the previous paint; they flash. */
  hot: ReadonlySet<string>;
  /** The board's steps by id, for the move menu. */
  byId: Map<string, PlanStep>;
  /** The task whose drawer is open; its card wears the aura. */
  activeTaskId?: string | null | undefined;
  onOpenTask: (id: string) => void;
  /** Changes a task's status; the shell toasts it with Undo. */
  onStatus: (id: string, st: TaskStatus, note?: string) => Promise<boolean> | boolean;
  onClear: () => void;
};

/** One card's face: its id and tags, its title as the drawer link, its owner and its waits. */
function CardFace({
  s,
  on,
  href,
  onOpenTask,
  onMove,
}: {
  s: Step;
  on: Map<string, string[]>;
  href: string;
  onOpenTask: (id: string) => void;
  onMove: (id: string, anchor: HTMLElement) => void;
}): JSX.Element {
  const k = stepState(s);
  const waits = (s.blocked_by ?? []).slice(0, 2).join(", ");
  return (
    <div class="board-card flex flex-col gap-1.5 p-4">
      <div class="flex items-center gap-1.5">
        <span class="badge badge-ghost badge-sm font-mono">{s.id}</span>
        {s.gate && s.gate !== "none" && !FIN.has(s.status ?? "todo") ? (
          <span class="text-base-content/50" title="Needs your approval">
            <Icon name="key" class="size-4" />
            <span class="sr-only">Needs your approval</span>
          </span>
        ) : null}
        {s.comments?.open ? (
          <span class="badge badge-ghost badge-sm h-5" title="Open notes">
            <Icon name="note" class="size-3.5" />
            {s.comments.open}
          </span>
        ) : null}
        <span class="flex-1" />
        {(on.get(s.id) ?? []).slice(0, 2).map((n) => (
          <span key={n} title={`${n} is on it`}>
            <Avatar name={n} small />
          </span>
        ))}
        <button
          type="button"
          class="btn btn-ghost btn-square btn-sm -mr-1.5"
          data-mv={s.id}
          aria-label={`Move ${s.id}`}
          aria-haspopup="menu"
          aria-expanded="false"
          onClick={(e) => {
            e.stopPropagation();
            onMove(s.id, e.currentTarget);
          }}
        >
          <Icon name="more" class="size-4.5" />
        </button>
      </div>
      <a
        class="line-clamp-3 block text-base leading-snug font-medium hover:underline"
        href={href}
        onClick={(e) => {
          e.preventDefault();
          onOpenTask(s.id);
        }}
      >
        {s.title}
      </a>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm muted">
        {s.owner ? who(s.owner) : <span class="text-base-content/50">nobody</span>}
        {k === "waiting" ? (
          <span class="inline-flex items-center gap-1 text-warning">
            <Icon name="hourglass" class="size-4" />
            {`waits on ${waits}${(s.blocked_by?.length ?? 0) > 2 ? "…" : ""}`}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** One card: the draggable slot around its face; the open task's card wears the aura. */
function Card({
  s,
  on,
  hot,
  active,
  href,
  onOpenTask,
  onMove,
}: {
  s: Step;
  on: Map<string, string[]>;
  hot: ReadonlySet<string>;
  active: boolean;
  href: string;
  onOpenTask: (id: string) => void;
  onMove: (id: string, anchor: HTMLElement) => void;
}): JSX.Element {
  const face = <CardFace s={s} on={on} href={href} onOpenTask={onOpenTask} onMove={onMove} />;
  return (
    <li
      class={hot.has(s.id) ? "flash" : ""}
      draggable
      data-id={s.id}
      data-active={active || undefined}
      onDragStart={(e) => {
        e.dataTransfer?.setData("text/plain", s.id);
        (e.currentTarget.querySelector(".board-card") ?? e.currentTarget).classList.add("drag");
      }}
      onDragEnd={(e) => {
        (e.currentTarget.querySelector(".board-card") ?? e.currentTarget).classList.remove("drag");
      }}
    >
      {active ? <div class="aura aura-glow aura-sm text-primary">{face}</div> : face}
    </li>
  );
}

/** One column's drag handlers: the card slides in, the drop changes the status. */
const drag = {
  over(e: DragEvent): void {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.add("over");
  },
  leave(e: DragEvent): void {
    (e.currentTarget as HTMLElement).classList.remove("over");
  },
  drop(onStatus: BoardProps["onStatus"], k: TaskStatus): (e: DragEvent) => void {
    return (e) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.remove("over");
      void onStatus(e.dataTransfer?.getData("text/plain") ?? "", k);
    };
  },
};

/** The work Board over the rows the filters keep. */
export function BoardView(props: BoardProps): JSX.Element {
  const { ch, api, board, rows, on, hot, byId, activeTaskId, onOpenTask, onStatus, onClear } = props;
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);

  const by = new Map<TaskStatus, Step[]>(COLS.map((k) => [k, rows.filter((s) => s.status === k)]));
  // empty Blocked and Skipped collapse to a rail, so the working columns keep the width
  const slim = (k: TaskStatus): boolean =>
    (k === "blocked" || k === "skipped") && (by.get(k)?.length ?? 0) === 0;
  const moveItems = (id: string): readonly MenuItem[] => {
    const s = byId.get(id);
    return COLS.filter((k) => k !== s?.status).map((k) => ({
      icon: <StatusIcon status={k} />,
      label: `Move to ${STATM[k].l}`,
      run: () => void onStatus(id, k),
    }));
  };

  return (
    <>
      {rows.length || board.steps.length ? (
        <div
          class="grid h-full items-start gap-4 overflow-x-auto max-md:grid-flow-col max-md:auto-cols-[80vw] max-md:snap-x"
          style={`grid-template-columns:${COLS.map((k) => (slim(k) ? "3rem" : "minmax(16rem,1fr)")).join(" ")}`}
        >
          {COLS.map((k) => {
            const cards = by.get(k) ?? [];
            return slim(k) ? (
              <section
                key={k}
                class="board-col flex min-h-40 flex-col items-center gap-2 rounded-box border border-dashed hairline py-3 max-md:hidden"
                data-col={k}
                aria-label={`${STATM[k].l}: empty`}
                onDragOver={drag.over}
                onDragLeave={drag.leave}
                onDrop={drag.drop(onStatus, k)}
              >
                <StatusIcon status={k} />
                <span class="text-sm muted [writing-mode:vertical-rl]">{STATM[k].l}</span>
                <span class="text-sm muted tnum">0</span>
              </section>
            ) : (
              <section
                key={k}
                class="board-col flex min-w-0 snap-start flex-col rounded-box bg-base-200/60"
                data-col={k}
                aria-labelledby={`kc-${k}`}
                onDragOver={drag.over}
                onDragLeave={drag.leave}
                onDrop={drag.drop(onStatus, k)}
              >
                <h2 class="flex items-center gap-2 px-4 pt-4 pb-2 text-sm font-semibold" id={`kc-${k}`}>
                  <StatusIcon status={k} />
                  {STATM[k].l}
                  <span class="badge badge-ghost badge-sm tnum">{cards.length}</span>
                </h2>
                <ul class="flex flex-col gap-3 px-3 pb-3 md:max-h-[calc(100dvh-250px)] md:overflow-y-auto">
                  {cards.length
                    ? cards.map((s) => (
                        <Card
                          key={s.id}
                          s={s}
                          on={on}
                          hot={hot}
                          active={activeTaskId === s.id}
                          href={taskHref(api, ch, s.id)}
                          onOpenTask={onOpenTask}
                          onMove={(id, anchor) => setMenu({ id, anchor })}
                        />
                      ))
                    : [
                        <li key={`none-${k}`} class="text-sm muted px-2 py-6 text-center">
                          {`No ${STATM[k].l.toLowerCase()} tasks`}
                        </li>,
                      ]}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <Panel>
          <EmptyTasks anySteps={board.steps.length > 0} onClear={onClear} />
        </Panel>
      )}
      {menu ? (
        <PopMenu anchor={menu.anchor} items={moveItems(menu.id)} onClose={() => setMenu(null)} />
      ) : null}
    </>
  );
}
