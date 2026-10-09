/**
 * The inspector's Overview tab, read top-down: the four numbers that size the call up (latency against the
 * view's p95, total tokens, estimated cost, retries — a stat each, on the panel surface), the token mix as
 * one stacked bar with its legend and its kind-by-kind table, where the call ran (session, agent, project,
 * router, upstream, provider), and the identifiers with their copy buttons. A burst of retries wears its
 * own warning alert, because a number alone never says what to do about it.
 */

import { Panel } from "@muhmdraouf/ui/page.tsx";
import type { ComponentChildren } from "preact";
import { Fragment } from "preact";
import { isInFlight, type RequestRecord, totalTokens } from "../../../shared/model.ts";
import { costDetailText, fmtDuration, fmtNum, fmtPercent, hostOf, sessionName } from "../../fmt.ts";
import { agentDisplayName, requestCost, stepScope } from "../../state.ts";
import { StackedBar } from "../Chart.tsx";
import { CopyButton } from "../Content.tsx";
import { useApp } from "../context.ts";
import { Icon } from "../Icon.tsx";
import { cardName } from "../SessionCard.tsx";
import { viaText } from "../views/Requests.tsx";
import { nearbyRetries, RETRY_LOOKBACK_MS, retriesText } from "./util.ts";

/** The tones a latency can earn: the three a comparison produces (never idle or info). */
type LatencyTone = "ok" | "warn" | "err";

/** Latency against the view's p95 as a tone: under 60% is fine, under 80% is a warning, the rest is slow. */
export function latencyTone(ratio: number): LatencyTone {
  return ratio < 0.6 ? "ok" : ratio < 0.8 ? "warn" : "err";
}

/** The verdict a latency earns, in words and in a semantic colour a colour-blind reader still gets. */
const LATENCY_WORDS: Record<LatencyTone, string> = {
  ok: "Fast for this view",
  warn: "Slower than most",
  err: "Among the slowest",
};
const LATENCY_TEXT: Record<LatencyTone, string> = {
  ok: "text-success",
  warn: "text-warning",
  err: "text-error",
};

/** One token kind's fill: semantic theme colours, so both Catppuccin themes keep their contrast. */
const TOKEN_FILL = {
  input: "var(--color-info)",
  output: "var(--color-secondary)",
  cacheRead: "var(--color-success)",
  cacheWrite5m: "var(--color-warning)",
  cacheWrite1h: "var(--color-accent)",
} as const;

/** One row of the tokens table: a colour dot when the kind has one, its tokens and its share. */
function TokenRow({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color?: string;
}) {
  return (
    <tr>
      <td>
        <span class="flex items-center gap-2 text-sm">
          {color !== undefined && (
            <span class="size-2.5 shrink-0 rounded-full" style={`background:${color}`} aria-hidden="true" />
          )}
          {label}
        </span>
      </td>
      <td class="num text-right">
        {value === 0 ? <span title="Not reported for this request">–</span> : fmtNum(value)}
      </td>
      <td class="num text-right text-base-content/60">
        {value === 0 || total === 0 ? "–" : fmtPercent(value / total)}
      </td>
    </tr>
  );
}

/** The Est. cost stat: the sum, the conditions that shaped it, and the honest words when nothing prices.
 *  A request still streaming shows "pending" — its opening numbers are not the bill. */
function CostStat({ request }: { request: RequestRecord }) {
  if (isInFlight(request)) {
    return (
      <>
        <span class="stat-value num flex items-center gap-1.5 text-2xl">
          <span class="loading loading-dots loading-sm" aria-hidden="true" />
          <span>pending</span>
        </span>
        <span class="stat-desc whitespace-normal">Still streaming; the bill lands when it ends.</span>
      </>
    );
  }
  const cost = requestCost(request);
  if (cost === null) {
    return (
      <Fragment>
        <span class="stat-value text-xl">tokens only</span>
        <span class="stat-desc whitespace-normal">No list price for this model.</span>
      </Fragment>
    );
  }
  const [sum, ...detail] = costDetailText(cost).split(" · ");
  return (
    <Fragment>
      <span class="stat-value num text-2xl font-semibold">{sum}</span>
      {detail.length > 0 && <span class="stat-desc whitespace-normal">{detail.join(" · ")}</span>}
    </Fragment>
  );
}

/** The retries stat: quiet when there are none, red when there are. */
function Retries({ retries }: { retries: RequestRecord[] }) {
  return (
    <div class="stat">
      <span class="stat-title">Retries</span>
      <span class={retries.length === 0 ? "stat-value num text-2xl" : "stat-value num text-error text-2xl"}>
        {fmtNum(retries.length)}
      </span>
      <span class="stat-desc whitespace-normal">{retriesText(retries)}</span>
    </div>
  );
}

/** The burst of retries as the design's alert under the stat row — a number alone never says what to do. */
function RetryBurst({ retries }: { retries: RequestRecord[] }) {
  if (retries.length === 0) return null;
  return (
    <div role="alert" class="alert alert-warning">
      <Icon name="alert" class="size-4.5 shrink-0" />
      <div class="min-w-0">
        <p class="m-0 font-medium">{retriesText(retries)}</p>
        <p class="m-0 text-meta">
          Failed attempts the view holds for this agent in the {Math.round(RETRY_LOOKBACK_MS / 60_000)}{" "}
          minutes before the request.
        </p>
      </div>
    </div>
  );
}

/** The request's tokens as one bar and one table: every kind's share of the whole, coloured the same. */
function TokensPanel({ request }: { request: RequestRecord }) {
  const t = request.tokens;
  const total = totalTokens(t);
  const write1h = request.cacheWrite1h ?? 0;
  const write5m = Math.max(0, t.cacheWrite - write1h);
  const kinds = [
    { label: "Input", value: t.input, fill: TOKEN_FILL.input },
    { label: "Output", value: t.output, fill: TOKEN_FILL.output },
    { label: "Cache read", value: t.cacheRead, fill: TOKEN_FILL.cacheRead },
    { label: "Cache write (5 min)", value: write5m, fill: TOKEN_FILL.cacheWrite5m },
    ...(write1h > 0 ? [{ label: "Cache write (1 h)", value: write1h, fill: TOKEN_FILL.cacheWrite1h }] : []),
  ];
  const shown = kinds.filter((kind) => kind.value > 0);
  return (
    <Panel title="Tokens" meta={`${fmtNum(total)} total`} icon={<Icon name="coins" />}>
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-2">
          <StackedBar segments={shown.map((kind) => ({ value: kind.value, color: kind.fill }))} max={total} />
          <div class="flex flex-wrap gap-x-5 gap-y-1">
            {shown.map((kind) => (
              <span class="flex items-center gap-1.5 text-sm">
                <span class="size-2.5 rounded-full" style={`background:${kind.fill}`} aria-hidden="true" />
                {kind.label}
                <span class="num muted">{fmtNum(kind.value)}</span>
              </span>
            ))}
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col" class="text-right">
                  Tokens
                </th>
                <th scope="col" class="text-right">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((kind) => (
                <TokenRow
                  key={kind.label}
                  label={kind.label}
                  value={kind.value}
                  total={total}
                  color={kind.fill}
                />
              ))}
              {t.thinking !== undefined && t.thinking > 0 && (
                <TokenRow label="Thinking (of output)" value={t.thinking} total={total} />
              )}
              <tr class="font-semibold">
                <td>Total</td>
                <td class="num text-right">{fmtNum(total)}</td>
                <td class="num text-right">{total === 0 ? "–" : "100%"}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {total === 0 && (
          <p class="muted m-0 text-sm">The provider reported no token usage for this request.</p>
        )}
      </div>
    </Panel>
  );
}

/** One definition row of "Where it ran": its name above its value. */
function Fact({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="min-w-0">
      <dt class="muted text-meta">{label}</dt>
      <dd class="m-0 mt-0.5 text-row">{children}</dd>
    </div>
  );
}

/** A mono identifier line with its copy button, for the Identifiers panel. */
function Identifier({ label, value }: { label: string; value: string }) {
  return (
    <div class="flex items-center gap-3">
      <span class="muted w-24 shrink-0 text-meta">{label}</span>
      <code class="min-w-0 flex-1 truncate font-mono text-sm" title={value}>
        {value}
      </code>
      <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}

/** Everything recorded about the request itself: its numbers, its tokens, its route, its ids. */
export function OverviewTab({ request }: { request: RequestRecord }) {
  const { state, act } = useApp();
  const session = state.sessions.find((s) => s.id === request.sessionId);
  const p95 = state.summary?.latencyP95 ?? null;
  const t = request.tokens;
  const total = totalTokens(t);
  const ratio = request.latencyMs === null || p95 === null || p95 <= 0 ? null : request.latencyMs / p95;
  const tone: LatencyTone | null = ratio === null ? null : latencyTone(ratio);
  const agentScope = JSON.stringify({ sessionId: request.sessionId, agentId: request.agentId });
  const retries = nearbyRetries(stepScope(state), request);
  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-col gap-3">
        <div class="stats stats-vertical w-full panel sm:stats-horizontal">
          <div class="stat">
            <span class="stat-title">Latency</span>
            <span class="stat-value num text-2xl">{fmtDuration(request.latencyMs)}</span>
            <span class="stat-desc whitespace-normal">
              {tone === null ? (
                "No view p95 to compare with yet."
              ) : (
                <Fragment>
                  <span class={`font-medium ${LATENCY_TEXT[tone]}`}>{LATENCY_WORDS[tone]}</span>
                  <span class="block">Measured against the view's p95 of {fmtDuration(p95)}.</span>
                </Fragment>
              )}
            </span>
          </div>
          <div class="stat">
            <span class="stat-title">Total tokens</span>
            <span class="stat-value num text-2xl">{fmtNum(total)}</span>
            <span class="stat-desc whitespace-normal">
              {fmtNum(t.input)} in, {fmtNum(t.output)} out
            </span>
          </div>
          <div class="stat">
            <span class="stat-title">Est. cost</span>
            <CostStat request={request} />
          </div>
          <Retries retries={retries} />
        </div>
        <RetryBurst retries={retries} />
      </div>
      <TokensPanel request={request} />
      <Panel title="Where it ran" icon={<Icon name="route" />}>
        <dl class="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          <Fact label="Session">{session === undefined ? request.sessionId : cardName(session)}</Fact>
          <Fact label="Agent">
            <span class="flex flex-col items-start gap-1.5">
              <span title={request.agentId}>
                {agentDisplayName(state, request.sessionId, request.agentId)}
              </span>
              <button
                type="button"
                class="btn btn-soft btn-sm"
                data-action="scope-agent"
                data-value={agentScope}
                onClick={() => act("scope-agent", agentScope)}
              >
                Show this agent's requests
              </button>
            </span>
          </Fact>
          <Fact label="Project">{session === undefined ? "–" : sessionName(session)}</Fact>
          <Fact label="Through">{viaText(request.via) ?? "Direct"}</Fact>
          <Fact label="Upstream">
            <span class="break-all font-mono text-sm">{hostOf(request.upstream)}</span>
          </Fact>
          <Fact label="Provider">{request.provider}</Fact>
        </dl>
      </Panel>
      <Panel title="Identifiers" icon={<Icon name="dot" />}>
        <div class="flex flex-col gap-3">
          <Identifier label="Session id" value={request.sessionId} />
          <Identifier label="Request id" value={request.id} />
          {request.parentAgentId !== undefined && (
            <Identifier label="Parent agent" value={request.parentAgentId} />
          )}
        </div>
      </Panel>
    </div>
  );
}
