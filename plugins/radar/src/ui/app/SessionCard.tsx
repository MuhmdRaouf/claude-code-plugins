/**
 * The rail's session card: a daisyUI `card` that answers, top to bottom, what the session is doing right
 * now, where it runs (branch, worktree, the full path), and how heavy it is (models, how full the main
 * context is, the agents, the cost) — then the activity strip that says how it went. One button per
 * card: clicking toggles the session in or out of the picked set (the pick wears the aura), Enter picks
 * where the arrows land, X anywhere on the rail clears.
 */

import type { Activity } from "../../shared/model.ts";
import { fmtAgo, fmtCount, fmtDuration, fmtTokens, fmtUsd, homeShort } from "../fmt.ts";
import { ActivityStrip, modelShares } from "./ActivityStrip.tsx";
import { useApp } from "./context.ts";
import { Icon } from "./Icon.tsx";
import { ModelChip } from "./kit.tsx";

/** The fields both rails' cards read, whether the session is live now or a history root. */
export type CardSession = {
  id: string;
  name: string;
  /** The repo root, falling back to the working directory. */
  repo: string | null;
  /** The working directory the session runs in; null when the store never learned it. */
  cwd: string | null;
  branch: string | null;
  /** Claude Code's own registry status while the session is open; null once it ended. */
  status: "working" | "idle" | null;
  live: boolean;
  costUsd: number | null;
  /** The models the session used, busiest first. */
  models: string[];
  /** How many of the session's subagents are live (0 hides the badge). */
  liveAgents: number;
  /** Every agent the session ever ran, live or not: the muted total beside the live badge. */
  agentCount: number;
  startedAt: number | null;
  /** When the session ended; null while it is open. */
  endedAt: number | null;
  /** The newest activity the store saw, whatever agent made it. */
  lastAt: number;
  /** What the main agent is doing right now — its newest call's one-line what and when that request
   *  went out. Live sessions only; null otherwise. */
  now: { what: string | null; ts: number } | null;
  /** How full that call's context window is, and how large the window is. Live sessions only; null
   *  otherwise. */
  context: { used: number; window: number } | null;
  activity: Activity;
};

/** The models a session used, busiest first, each named once. */
export function modelsOf(activity: Activity): string[] {
  return modelShares(activity).map((share) => share.model);
}

/** The card's name: the session's own, else the project, else the id's head — never nothing. */
export function cardName(item: { id: string; name: string | null; project: string | null }): string {
  return item.name ?? item.project ?? item.id.slice(0, 8);
}

/** A live rail item as a card: live subagents from the view's count, models from the activity strip. */
export function cardOfSession(item: {
  id: string;
  name: string | null;
  project: string | null;
  repo: string | null;
  cwd: string | null;
  branch: string | null;
  status: "working" | "idle" | null;
  live: boolean;
  agentCount: number;
  liveAgentCount: number;
  startedAt: number | null;
  endedAt: number | null;
  lastAt: number;
  costUsd?: number | null;
  now?: { what: string | null; ts: number } | null;
  context?: { used: number; window: number } | null;
  activity: Activity;
}): CardSession {
  return {
    id: item.id,
    name: cardName(item),
    repo: item.repo ?? item.cwd,
    cwd: item.cwd,
    branch: item.branch,
    status: item.live ? item.status : null,
    live: item.live,
    costUsd: item.costUsd ?? null,
    models: modelsOf(item.activity),
    liveAgents: liveSubagents(item.liveAgentCount, item.live),
    agentCount: item.agentCount,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    lastAt: item.lastAt,
    now: item.now ?? null,
    context: item.context ?? null,
    activity: item.activity,
  };
}

/** The word, the daisyUI status dot's class, and whether the dot pings: working lights the success dot
 *  with its pinging twin, waiting at the prompt turns the dot warning, an ended session keeps the
 *  component's quiet default, and a live session whose registry status is still unknown reads alive too —
 *  the steady success dot, never "Ended" while it is open. */
export function statusBar(
  status: CardSession["status"],
  live: boolean,
): { word: string; dot: string; ping: boolean } {
  if (status === "working") return { word: "Working", dot: "status-success", ping: true };
  if (status === "idle") return { word: "Waiting for you", dot: "status-warning", ping: false };
  return live
    ? { word: "Working", dot: "status-success", ping: false }
    : { word: "Ended", dot: "", ping: false };
}

/** How many of the session's subagents are live: the store's live count includes the session's own main
 *  agent, and the card's badge speaks about the subagents — the main session is the card itself. A
 *  session that is not live has nothing live, whatever a stale count said. */
export function liveSubagents(liveAgentCount: number, live: boolean): number {
  return live ? Math.max(0, liveAgentCount - 1) : 0;
}

/** The worktree a working directory runs in, for the card's badge: the segment a `worktrees/` folder
 *  names (".agents/worktrees/homelab" → "homelab", ".claude/worktrees/x/sub" → "x"), or, for a checkout
 *  outside the repo (a linked worktree elsewhere), its last segment. The repo root itself and a plain
 *  subfolder of the repo name nothing. */
export function worktreeName(cwd: string | null, repo: string | null): string | null {
  if (cwd === null || repo === null || cwd === repo) return null;
  if (cwd.startsWith(`${repo}/`)) {
    const segments = cwd.slice(repo.length + 1).split("/");
    for (let at = segments.length - 2; at >= 0; at -= 1) {
      if (segments[at] === "worktrees") return segments[at + 1] ?? null;
    }
    return null; // a plain subfolder of the repo
  }
  return (
    cwd
      .split("/")
      .filter((part) => part !== "")
      .pop() ?? null
  );
}

/** A working directory split for the card's path line: the repo prefix (`head`, quiet) and the
 *  worktree or subfolder inside it (`tail`, brighter), both home-shortened. Outside the repo, or
 *  without one, the whole directory is the tail; without a directory the repo path stands alone. */
export function pathParts(cwd: string | null, repo: string | null): { head: string; tail: string } {
  if (cwd === null) return { head: repo === null ? "" : homeShort(repo), tail: "" };
  if (repo === null || !cwd.startsWith(`${repo}/`)) return { head: "", tail: homeShort(cwd) };
  return { head: `${homeShort(repo)}/`, tail: homeShort(cwd.slice(repo.length + 1)) };
}

/** The context gauge's percentage and semantic colour: green while there is room, warning as it fills,
 *  error at 85% — where the alerts engine fires about compaction. */
export function contextGauge(used: number, window: number): { pct: number; tone: string } {
  const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
  return { pct, tone: pct < 60 ? "text-success" : pct < 85 ? "text-warning" : "text-error" };
}

/** Walk the rail's cards with the arrow keys: focus moves, the reader presses Enter where they land. */
export function moveFocus(card: HTMLElement, delta: -1 | 1): void {
  const list = card.closest("[data-card-list]");
  if (list === null) return;
  const cards = [...list.querySelectorAll<HTMLElement>("button[data-card]")];
  const next = cards[cards.indexOf(card) + delta];
  if (next !== undefined) next.focus();
}

/** The key down handler every card shares: the arrow keys walk the rail, everything else is the button's
 *  own (Space and Enter toggle the session; X is the rail's, on the list container). */
export function cardKeys(event: KeyboardEvent, currentTarget: HTMLElement): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  moveFocus(currentTarget, event.key === "ArrowDown" ? 1 : -1);
}

/** The rail-wide X: clear the picked set, from wherever in the card list the focus sits. */
export function clearOnX(clear: () => void): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key !== "x" && event.key !== "X") return;
    event.preventDefault();
    clear();
  };
}

/** The action a call took, without the input that led to it: whatOf joins its sides with two spaces, so
 *  the split looks for that separator ("↳ 1 tool result  → Bash cd x" reads "Bash cd x") and an arrow
 *  inside the prompt or a tool argument stays; a line with no separator stands as it is. */
export function nowAction(what: string): string {
  const at = what.lastIndexOf("  → ");
  return (at === -1 ? what : what.slice(at + 4)).replace(/^\s*↳\s*/, "").trim() || what;
}

/** A path with a break opportunity after every slash, so it wraps between folders, not inside a name. */
function slashBreaks(path: string) {
  return path.split("/").map((part, i, all) => (
    <span key={i}>
      {part}
      {i < all.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </span>
  ));
}

/** The card's now line: what the session is doing at this moment — the main agent's newest call while it
 *  works, "Waiting for you" at the prompt, "Ended" with the run's length once it is over. */
function NowLine({ session, now }: { session: CardSession; now: number }) {
  if (!session.live) {
    const endedAt = session.endedAt ?? session.lastAt;
    const ran =
      session.startedAt === null ? "" : ` · ran ${fmtDuration(Math.max(0, endedAt - session.startedAt))}`;
    return <span class="truncate text-sm text-base-content/60">{`Ended ${fmtAgo(endedAt, now)}${ran}`}</span>;
  }
  if (session.status === "idle") {
    return (
      <span class="truncate text-sm text-warning" title="The session is open, waiting at its prompt">
        {session.lastAt > 0 ? `Waiting for you · ${fmtAgo(session.lastAt, now)}` : "Waiting for you"}
      </span>
    );
  }
  const current = session.now;
  if (current === null || current.what === null) {
    return <span class="truncate text-sm text-base-content/60">Working · {fmtAgo(session.lastAt, now)}</span>;
  }
  return (
    <span class="flex min-w-0 items-center gap-1.5 text-sm">
      <Icon name="play" class="size-4 shrink-0 text-success" />
      <span class="min-w-0 truncate font-mono" title={current.what}>
        {nowAction(current.what)}
      </span>
      <span class="num shrink-0 text-base-content/60">{`· ${fmtAgo(current.ts, now)}`}</span>
    </span>
  );
}

/** The card's where block: the branch and the worktree as badges over the full working directory, the
 *  repo prefix dimmer and the place inside it brighter. Never truncated — the path wraps — and no box
 *  inside the box: the rows are set apart by spacing alone. */
function WhereBlock({ session }: { session: CardSession }) {
  if (session.cwd === null && session.repo === null) return null;
  const worktree = worktreeName(session.cwd, session.repo);
  const parts = pathParts(session.cwd, session.repo);
  return (
    <span class="flex min-w-0 flex-col gap-1.5">
      {(session.branch !== null || worktree !== null) && (
        <span class="flex min-w-0 flex-wrap items-center gap-1.5">
          {session.branch !== null && (
            <span
              class="badge badge-outline border-base-content/15 text-base-content/80 min-w-0 max-w-full gap-1.5"
              title={`Branch ${session.branch}`}
            >
              <Icon name="branch" class="size-3.5 shrink-0 text-secondary" />
              <span class="min-w-0 truncate">{session.branch}</span>
            </span>
          )}
          {worktree !== null && session.repo !== null && (
            <span
              class="badge badge-outline border-base-content/15 text-base-content/80 min-w-0 max-w-full gap-1.5"
              title={`Worktree ${worktree} of ${session.repo}`}
            >
              <Icon name="worktree" class="size-3.5 shrink-0 text-info" />
              <span class="min-w-0 truncate">{worktree}</span>
            </span>
          )}
        </span>
      )}
      <span class="flex min-w-0 items-start gap-1.5">
        <Icon name="folder" class="mt-px size-3.5 shrink-0 text-base-content/50" />
        <span class="min-w-0 break-words font-mono text-xs text-base-content/60 leading-snug">
          {parts.head !== "" && <span class="text-base-content/40">{slashBreaks(parts.head)}</span>}
          <span class="text-base-content/80">{slashBreaks(parts.tail)}</span>
        </span>
      </span>
    </span>
  );
}

/** The card's weight row: one chip per model, how full the main context is, the subagents still running
 *  and the agent total — the facts that say how heavy the session is. */
function WeightRow({ session }: { session: CardSession }) {
  const gauge = session.context === null ? null : contextGauge(session.context.used, session.context.window);
  const tip =
    session.context === null
      ? ""
      : `Main context ${fmtTokens(session.context.used)} of ${fmtTokens(session.context.window)} tokens`;
  return (
    <span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {session.models.map((model) => (
        <ModelChip key={model} model={model} />
      ))}
      {gauge !== null && (
        <span class="tooltip shrink-0" data-tip={tip}>
          <span
            class={`radial-progress ${gauge.tone} text-xs`}
            role="progressbar"
            aria-valuenow={gauge.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={tip}
            style={`--value:${gauge.pct};--size:2.25rem;--thickness:3px`}
          >
            {gauge.pct}
          </span>
        </span>
      )}
      {session.liveAgents > 0 && (
        <span
          class="badge badge-outline border-base-content/15 text-base-content/80 shrink-0 gap-1.5"
          title="Subagents still running"
        >
          <span class="status status-success" aria-hidden="true" />
          {session.liveAgents} running
        </span>
      )}
      {session.agentCount > 0 && (
        <span class="num shrink-0 text-base-content/60" title="Agents in this session, live and ended">
          {fmtCount(session.agentCount, "agent")}
        </span>
      )}
    </span>
  );
}

/** One session card: a daisyUI `card` whose rows read, in order, what it is doing, where it runs, how
 *  heavy it is — and, last, the activity strip. A picked card is wrapped in the aura (one child: the
 *  card), carries the "Viewing" check beside the cost, and answers `aria-pressed`. */
export function SessionCard({
  session,
  selected = false,
  onSelect,
}: {
  session: CardSession;
  selected?: boolean;
  onSelect: (id: string) => void;
}) {
  const { now } = useApp();
  const bar = statusBar(session.status, session.live);
  const card = (
    <button
      type="button"
      data-card=""
      data-action="session"
      data-value={session.id}
      aria-pressed={selected ? "true" : "false"}
      aria-label={`${session.name}, ${bar.word.toLowerCase()}`}
      onClick={() => onSelect(session.id)}
      onKeyDown={(e) => cardKeys(e, e.currentTarget)}
      class="card w-full cursor-pointer flex-col gap-3 rounded-box bg-base-100/60 p-4 text-left hover:bg-base-100"
    >
      <span class="flex min-w-0 items-center gap-2.5">
        {bar.ping ? (
          <span class="inline-grid shrink-0 *:[grid-area:1/1]" aria-hidden="true" title={bar.word}>
            <span class="status status-lg status-success motion-safe:animate-ping" />
            <span class="status status-lg status-success text-success neon-dot" />
          </span>
        ) : (
          <span
            class={`status status-lg shrink-0 ${bar.dot === "" ? "" : bar.dot}`}
            aria-hidden="true"
            title={bar.word}
          />
        )}
        <span class="sr-only">{bar.word}</span>
        <span class="min-w-0 truncate text-base font-semibold">{session.name}</span>
        {selected && (
          <span
            class="badge badge-outline border-base-content/15 text-base-content/80 shrink-0 gap-1.5"
            title="This session is in the view"
          >
            <Icon name="check" class="size-3.5 text-primary" />
            <span>Viewing</span>
          </span>
        )}
        {session.costUsd !== null && (
          <span
            class="num ml-auto shrink-0 text-[0.9375rem] font-medium"
            title="Estimated cost at list price"
          >
            {fmtUsd(session.costUsd)}
          </span>
        )}
      </span>
      <NowLine session={session} now={now} />
      <WhereBlock session={session} />
      <WeightRow session={session} />
      <ActivityStrip
        activity={session.activity}
        window={session.live ? "in the last 15 minutes" : "in this session"}
        height={24}
      />
    </button>
  );
  return selected ? (
    <div class="aura aura-catppuccin aura-sm block w-full [--tw-duration:16s] [&>*]:!bg-base-100">{card}</div>
  ) : (
    card
  );
}
