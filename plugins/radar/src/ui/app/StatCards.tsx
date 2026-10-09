/**
 * The overview's numbers and scope: the seven stats as panel cards (four across on xl), a "Session"
 * panel carrying the facts that left the old header when exactly one session is picked, and the budget
 * bars. Stats whose data cannot follow the range say "all time" plainly instead of letting the reader
 * assume the range.
 */

import { Panel } from "@muhmdraouf/ui/page.tsx";
import type { ComponentChildren } from "preact";
import type { Budget, BudgetSpend } from "../../budget/budgets.ts";
import { addCost } from "../../cost/prices.ts";
import { NOTICE_EVENT, type Summary } from "../../shared/model.ts";
import { scopeLabel } from "../../shared/provider.ts";
import { fmtAgo, fmtDuration, fmtNum, fmtUsd, homeShort } from "../fmt.ts";
import { budgetTone, STATUS_COLOR } from "../palette.ts";
import {
  type ClientState,
  flowSource,
  pickedSessions,
  visibleEvents,
  visibleRequests,
  visibleTools,
} from "../state.ts";
import { StackedBar } from "./Chart.tsx";
import { useApp } from "./context.ts";
import { rangePhrase, requestsInRange } from "./Flow.tsx";
import { Icon } from "./Icon.tsx";
import { Status } from "./kit.tsx";
import { isJob } from "./Sessions.tsx";

/** One number on the overview: a daisyUI stat on the panel surface, its title quiet, its figure big. */
function Stat({
  title,
  value,
  subline = null,
}: {
  title: string;
  value: string;
  subline?: ComponentChildren;
}) {
  return (
    <div class="stats panel w-full">
      <div class="stat w-full p-5">
        <div class="stat-title text-sm font-normal text-base-content/65">{title}</div>
        <div class="stat-value num text-3xl font-semibold">{value}</div>
        {subline !== null && <div class="stat-desc text-xs whitespace-normal">{subline}</div>}
      </div>
    </div>
  );
}

/** The grid the stat cards sit in: one across on phones, two from md, four from xl. */
const STAT_GRID = "grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4";

/** The stop reasons the server's summary counts as errors (store/aggregate.ts), so the strip's range
 *  count — notices included, as the summary's own count is — matches the all-time count it replaces. */
const STOP_ERRORS = new Set(["error", "overloaded_error", "api_error", "request_error"]);

/** Linear-interpolation percentile, the same maths the server's aggregate runs over its summary. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low] ?? sorted[sorted.length - 1] ?? 0;
  if (low === high) return lowValue;
  const highValue = sorted[high] ?? lowValue;
  const weight = rank - low;
  return Math.round(lowValue + (highValue - lowValue) * weight);
}

/** The scope's words: all sessions, the one picked session, or the picked set. */
function scopeWord(count: number): string {
  if (count === 0) return "across all sessions";
  if (count === 1) return "in this session";
  return `across ${fmtNum(count)} picked sessions`;
}

/** Estimated spend today (the ledger), with what the picked sessions — or, plainly, everything
 *  loaded — is priced at. The subline never claims the range: only the ledger's own day is named. */
function CostStat() {
  const { state } = useApp();
  const picked = pickedSessions(state);
  const inView =
    picked.length === 0
      ? (state.summary?.costUsd ?? null)
      : picked.reduce<number | null>((sum, item) => addCost(sum, item.costUsd ?? null), null);
  return (
    <Stat
      title="Est. cost today"
      value={fmtUsd(state.spendToday)}
      subline={
        state.spendToday === null && inView === null
          ? "Nothing priced yet. A Claude subscription may cover Claude usage; these are API list prices."
          : `${inView === null ? "Nothing priced" : fmtUsd(inView)} ${scopeWord(picked.length)} (estimate)`
      }
    />
  );
}

/** What the strip knows about the selected range: whether the records in memory reach across it, how many
 *  requests ran, and the span in words ("in the last 6 hours"), scope-named when sessions are picked. */
type RangeFacts = {
  from: number;
  to: number;
  memory: boolean;
  requests: number | null;
  span: string;
  scope: string | null;
};

/** Facts about the selected range from the data the client holds. */
function rangeFacts(state: ClientState, now: number): RangeFacts {
  const { from, to, history } = flowSource(state, now);
  const picked = pickedSessions(state);
  const noun = rangePhrase(state.range);
  const scopeNoun = noun.replace(/^the /, "");
  return {
    from,
    to,
    memory: !history,
    // with sessions picked, the history answer counts every session: a single pick's own stored count
    // stands in, and a set sums its picks' stored counts; memory answers the set directly
    requests:
      history && picked.length > 0
        ? picked.reduce((sum, item) => sum + item.requestCount, 0)
        : requestsInRange(state, now),
    span: `in ${noun}`,
    scope:
      picked.length === 0
        ? null
        : picked.length === 1
          ? `in this session, ${history ? "all time" : scopeNoun}`
          : `in ${fmtNum(picked.length)} picked sessions${history ? ", all time" : ""}`,
  };
}

/** The range-scoped counts behind the strip, from the records in memory. Null parts when memory does not
 *  reach across the range (it runs on the history route): those stats say "all time" instead. */
type RangeCounts = {
  tools: number | null;
  failures: number | null;
  errors: number | null;
  latencies: number[] | null;
};

function rangeCounts(state: ClientState, facts: RangeFacts): RangeCounts {
  if (!facts.memory) return { tools: null, failures: null, errors: null, latencies: null };
  const inRange = (ts: number): boolean => ts >= facts.from && ts <= facts.to;
  const rangeTools = visibleTools(state).filter((tool) => inRange(tool.startedAt));
  const rangeRequests = visibleRequests(state).filter((r) => inRange(r.ts));
  const rangeEvents = visibleEvents(state).filter((event) => inRange(event.ts));
  const failures = rangeTools.filter((tool) => !tool.ok).length;
  return {
    tools: rangeTools.length,
    failures,
    // the same shape the server's summary counts: failed tools, error stops, and Claude Code's notices
    errors:
      failures +
      rangeRequests.filter((r) => r.stopReason !== null && STOP_ERRORS.has(r.stopReason)).length +
      rangeEvents.filter((event) => event.kind === NOTICE_EVENT).length,
    latencies: rangeRequests.map((r) => r.latencyMs).filter((v): v is number => v !== null),
  };
}

/** The subline of a stat that follows the range: its span, plus a tone word when something needs a look. */
function RangeSubline({
  span,
  failures = 0,
  look = false,
}: {
  span: string;
  failures?: number;
  look?: boolean;
}) {
  return (
    <>
      <span class="block">{span}</span>
      {failures > 0 && <Status tone="err" word={`${fmtNum(failures)} failed`} />}
      {look && <Status tone="err" word="Needs a look" />}
    </>
  );
}

/** The latency stat's subline: the range's median, then the span it covers. */
function LatencySubline({ latencies, span }: { latencies: number[]; span: string }) {
  const median = percentile(latencies, 50);
  return (
    <>
      {median !== null && <span class="block">{`Median ${fmtDuration(median)}`}</span>}
      {span}
    </>
  );
}

/** The four range-following numbers — requests, tool calls, errors, latency — falling back to the
 *  all-time totals, said plainly, where only the history route could scope them. */
function RangeStats({
  summary,
  facts,
  counts,
}: {
  summary: Summary;
  facts: RangeFacts;
  counts: RangeCounts;
}) {
  return (
    <>
      <Stat
        title="Requests"
        value={facts.requests === null ? "–" : fmtNum(facts.requests)}
        subline={facts.scope ?? facts.span}
      />
      <Stat
        title="Tool calls"
        value={counts.tools === null ? fmtNum(summary.toolCalls) : fmtNum(counts.tools)}
        subline={
          counts.tools === null ? (
            "all time"
          ) : (
            <RangeSubline span={facts.span} failures={counts.failures ?? 0} />
          )
        }
      />
      <Stat
        title="Errors"
        value={counts.errors === null ? fmtNum(summary.errors) : fmtNum(counts.errors)}
        subline={
          counts.errors === null ? (
            "all time"
          ) : (
            <RangeSubline span={facts.span} look={(counts.errors ?? 0) > 0} />
          )
        }
      />
      <Stat
        title="Latency p95"
        value={fmtDuration(counts.latencies === null ? summary.latencyP95 : percentile(counts.latencies, 95))}
        subline={
          counts.latencies === null ? (
            `Median ${fmtDuration(summary.latencyP50)}, all time`
          ) : (
            <LatencySubline latencies={counts.latencies} span={facts.span} />
          )
        }
      />
    </>
  );
}

/** The overview's seven numbers; empty until the first snapshot arrives. */
export function StatCards() {
  const { state, now } = useApp();
  const summary = state.summary;
  if (summary === null) return <section class={STAT_GRID} aria-label="Overview numbers" data-stat-cards="" />;
  const facts = rangeFacts(state, now);
  const counts = rangeCounts(state, facts);
  // the sessions number is the rail's own basis: the registry's live main sessions, never jobs —
  // the summary's live count reads jobs as live, and that mismatch showed "17 live now" over 5 cards
  const main = state.sessions.filter((item) => !isJob(item));
  // a multi-pick narrows the strip to the picked sessions, summing their list items; a single pick and
  // the whole-fleet view keep the fleet's numbers, as the strip always read them
  const scope = pickedSessions(state);
  const multi = scope.length > 1;
  const fleetLive = main.filter((item) => item.live).length;
  const fleetEnded = main.length - fleetLive;
  const setLive = scope.filter((item) => item.live).length;
  const setAgents = scope.reduce((sum, item) => sum + item.agentCount, 0);
  return (
    <section class={STAT_GRID} data-stat-cards="">
      <CostStat />
      <Stat
        title="Sessions"
        value={fmtNum(multi ? scope.length : main.length)}
        subline={
          multi ? (
            setLive > 0 ? (
              <Status tone="ok" word={`${fmtNum(setLive)} of ${fmtNum(scope.length)} live now`} pulse />
            ) : null
          ) : fleetLive > 0 ? (
            <Status
              tone="ok"
              word={`${fmtNum(fleetLive)} live now${fleetEnded > 0 ? `, ${fmtNum(fleetEnded)} ended` : ""}`}
              pulse
            />
          ) : null
        }
      />
      <Stat
        title="Agents"
        value={fmtNum(multi ? setAgents : summary.agents)}
        subline={multi ? "in the picked sessions, all time" : "all time"}
      />
      <RangeStats summary={summary} facts={facts} counts={counts} />
      <SessionScopePanel />
    </section>
  );
}

/** The split's one side: the family's estimate, a dash when nothing of its models was priced. */
const sideOf = (cost: number | null): string => (cost === null ? "–" : fmtUsd(cost));

/** The picked session's all-time estimate split by model family — the same store totals the rail's
 *  card sums, so the shown parts always add up to the card's number. Null when nothing prices. */
export function costSplitText(split: {
  claude: number | null;
  glm: number | null;
  other: number | null;
}): string | null {
  if (addCost(addCost(split.claude, split.glm), split.other) === null) return null;
  const parts = [`${sideOf(split.claude)} Claude`, `${sideOf(split.glm)} GLM`];
  if (split.other !== null) parts.push(`${fmtUsd(split.other)} other`);
  return parts.join(" / ");
}

/** One fact of the picked session: the label over the value, never joined by middle dots. */
function ScopeFact({ label, value, title }: { label: string; value: string; title?: string | undefined }) {
  return (
    <div class="grid gap-0.5">
      <dt class="text-xs text-base-content/60">{label}</dt>
      <dd class="min-w-0 truncate text-row" title={title ?? value}>
        {value}
      </dd>
    </div>
  );
}

/** The facts that left the old scope header: the one picked session's name, path, branch, start and
 *  the Claude-versus-GLM cost split, in one panel under the stat cards. Hidden unless exactly one
 *  session is picked — a set reads its facts in the cards above. */
export function SessionScopePanel() {
  const { state, now } = useApp();
  if (state.selected.length !== 1) return null;
  const item = pickedSessions(state)[0];
  if (item === undefined) return null;
  const workspace = item.repo ?? item.cwd;
  const split = item.costSplitUsd ?? null;
  return (
    <Panel title="Session" meta={item.live ? "Live" : "Ended"} class="md:col-span-2 xl:col-span-4">
      <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ScopeFact label="Name" value={item.name ?? item.project ?? item.id.slice(0, 8)} title={item.id} />
        {workspace !== null && <ScopeFact label="Path" value={homeShort(workspace)} title={workspace} />}
        {item.branch !== null && <ScopeFact label="Branch" value={item.branch} />}
        <ScopeFact
          label="Started"
          value={item.startedAt === null ? "–" : fmtAgo(item.startedAt, now)}
          title={item.status ?? undefined}
        />
        {split !== null && (
          <ScopeFact
            label="Est. cost, Claude vs GLM"
            value={costSplitText(split) ?? "–"}
            title="Estimated cost at list price, all time, split by model family — the parts add up to the card's estimate"
          />
        )}
      </dl>
    </Panel>
  );
}

const PERIOD_NOUN: Record<Budget["period"], string> = {
  day: "today",
  week: "this week",
  month: "this month",
};

/** One budget's progress: scope and period, a tone word, whether it stops anything, and the bar. */
function BudgetRow({ spend }: { spend: BudgetSpend }) {
  const tone = budgetTone(spend.pct);
  const word =
    tone === "err" ? (spend.action === "stop" ? "Stopped" : "Over") : tone === "warn" ? "Near" : "On track";
  const badge =
    tone === "err"
      ? "badge badge-sm badge-error badge-soft shrink-0"
      : tone === "warn"
        ? "badge badge-sm badge-warning badge-soft shrink-0"
        : "badge badge-sm badge-success badge-soft shrink-0";
  return (
    <div class="flex min-w-0 flex-col gap-1.5" data-budget-row="">
      <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span class="min-w-0 truncate text-sm font-medium">{`${scopeLabel(spend.scope)}, ${PERIOD_NOUN[spend.period]}`}</span>
        <span class={badge}>{word}</span>
        <span class="shrink-0 text-xs text-base-content/60">
          {spend.action === "stop" ? "Stops requests at 100%" : "Warns only"}
        </span>
        <span class="num ml-auto shrink-0 text-sm text-base-content/70">
          {`${fmtUsd(spend.spentUsd)} of ${fmtUsd(spend.limitUsd)} (${Math.round(spend.pct)}%)`}
        </span>
      </div>
      <StackedBar segments={[{ value: Math.min(spend.pct, 100), color: STATUS_COLOR[tone] }]} max={100} />
    </div>
  );
}

/** The overview's budget progress bars; nothing when no budget is set. */
export function BudgetCard() {
  const { state, act } = useApp();
  const spend = state.budgetStatus?.spend ?? [];
  if (spend.length === 0) return null;
  return (
    <Panel
      title="Budgets"
      meta="Estimated spend against each limit"
      icon={<Icon name="dollar" />}
      actions={
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          data-action="tab"
          data-value="settings"
          onClick={() => act("tab", "settings")}
        >
          <Icon name="settings" class="size-4.5" />
          <span>Edit</span>
        </button>
      }
    >
      <div class="grid gap-4">
        {spend.map((s) => (
          <BudgetRow key={s.id} spend={s} />
        ))}
      </div>
    </Panel>
  );
}
