/**
 * The agents tab: one daisyUI table per session — Main first, then subagents nested by spawn depth, ended
 * rows dimmed, jobs at the bottom with their own subagents under them. Columns: status, agent, model,
 * requests, tokens, est. cost, latency p95, last activity. Clicking a row opens the agent's live
 * transcript in a slide-over; the tree chevron only folds.
 */

import type { ComponentChildren } from "preact";
import { type AgentView, type SessionView, totalTokens } from "../../../shared/model.ts";
import type { SessionListItem } from "../../../store/store.ts";
import { fmtCount, fmtDuration, fmtNum, fmtTokens, fmtUsd, sessionName } from "../../fmt.ts";
import type { IconName } from "../../icons.ts";
import { agentNodeId, detailTargets } from "../../state.ts";
import { useApp } from "../context.ts";
import { Icon } from "../Icon.tsx";
import { EmptyState, ModelChip, Panel } from "../kit.tsx";
import { type Column, Table, TableHeadStatic, TableRow, timeText } from "../table.tsx";

const AGENT_ICON: Record<AgentView["kind"], IconName> = { main: "bot", subagent: "branch", external: "plug" };

export const AGENT_COLUMNS: Column<string>[] = [
  { key: "status", label: "Status", width: "w-40" },
  { key: "agent", label: "Agent" },
  { key: "model", label: "Model", width: "w-40" },
  { key: "requests", label: "Requests", numeric: true, width: "w-24" },
  { key: "tokens", label: "Tokens", numeric: true, width: "w-28" },
  { key: "cost", label: "Est. cost", numeric: true, width: "w-28" },
  { key: "p95", label: "Latency p95", numeric: true, width: "w-28" },
  { key: "last", label: "Last activity", width: "w-32" },
];

/** Main before subagents before externals; within a kind, the most recent activity first. */
export function compareAgents(a: AgentView, b: AgentView): number {
  const kindOrder = (k: AgentView["kind"]): number => (k === "main" ? 0 : k === "subagent" ? 1 : 2);
  return kindOrder(a.kind) - kindOrder(b.kind) || (b.lastAt ?? 0) - (a.lastAt ?? 0);
}

/** The collapse chevron of one agent row; an agent without children carries a leaf instead. */
function AgentToggle({
  sessionId,
  agent,
  hasChildren,
  collapsed,
}: {
  sessionId: string;
  agent: AgentView;
  hasChildren: boolean;
  collapsed: boolean;
}) {
  const { act } = useApp();
  if (!hasChildren) return <span class="tree-toggle tree-leaf" aria-hidden="true" />;
  const value = `${sessionId}/${agent.id}`;
  return (
    <button
      type="button"
      class="tree-toggle"
      data-action="collapse"
      data-value={value}
      aria-expanded={collapsed ? "false" : "true"}
      aria-label={`${collapsed ? "Expand" : "Collapse"} ${agent.name ?? agent.id}`}
      onClick={(event) => {
        event.stopPropagation(); // the row around it may pick the agent; the chevron only folds
        act("collapse", value);
      }}
    >
      <Icon name={collapsed ? "chevronRight" : "chevronDown"} class="icon" />
    </button>
  );
}

/** The status cell: one live/ended badge and, on the same line, the failure count when there are any. */
function AgentStatusCell({ agent }: { agent: AgentView }) {
  return (
    <div class="flex flex-wrap items-center gap-1.5">
      {agent.live ? (
        <span class="badge badge-success badge-soft">
          <span class="status status-success neon-dot motion-safe:animate-ping" aria-hidden="true" />
          Live
        </span>
      ) : (
        <span class="badge badge-ghost">Ended</span>
      )}
      {agent.errors > 0 && <span class="badge badge-error badge-soft">{fmtNum(agent.errors)} failed</span>}
    </div>
  );
}

/** The cost cell: the estimate (the column header carries the "est.") when any of the agent's models is
 *  priced, a dash when not. */
function AgentCostCell({ cost }: { cost: AgentView["costUsd"] }) {
  return (
    <td
      class="num text-right"
      {...(cost !== undefined && cost !== null ? { title: "Estimate at list price" } : {})}
    >
      {cost !== undefined && cost !== null ? (
        <span class="tree-cost font-medium text-success">{fmtUsd(cost)}</span>
      ) : (
        <span class="text-base-content/60">–</span>
      )}
    </td>
  );
}

/** The last-activity cell: the reader's time mode with the other one as its tooltip, or a dash. */
function AgentLastCell({ at }: { at: number | null }) {
  const { state, now } = useApp();
  const when = at === null ? null : timeText(state, at, now);
  return (
    <td class="time" {...(when === null ? {} : { title: when.title })}>
      {when === null ? <span class="text-base-content/60">–</span> : when.text}
    </td>
  );
}

/** The latency cell: the agent's requests at their 95th percentile, a dash under five timed ones. */
function AgentP95Cell({ p95 }: { p95: AgentView["latencyP95"] }) {
  return (
    <td class="num text-right" title="95th percentile request latency">
      {p95 == null ? <span class="text-base-content/60">–</span> : fmtDuration(p95)}
    </td>
  );
}

/** One agent row: its state, name and model, then the numbers — requests, tokens, cost, p95, last seen.
 *  `onPick` (both views) opens the agent's live transcript; the chevron beside the name only folds. */
function AgentRow({
  sessionId,
  agent,
  depth,
  hasChildren,
  collapsed,
  active = false,
  onPick,
}: {
  sessionId: string;
  agent: AgentView;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  active?: boolean;
  onPick?: ((agent: AgentView) => void) | undefined;
}) {
  /** What the row is called: Main for the session itself, else the task, else today's name. */
  const label = agent.kind === "main" ? "Main" : (agent.description ?? agent.name ?? agent.id.slice(0, 10));
  return (
    <TableRow
      {...(onPick === undefined ? { active } : { onOpen: () => onPick(agent), active })}
      dimmed={!agent.live}
    >
      <td class={active ? "shadow-[inset_3px_0_0_0_var(--color-primary)]" : undefined}>
        <AgentStatusCell agent={agent} />
      </td>
      <td>
        <div class="flex items-center gap-2" style={`padding-left:${depth * 22}px`}>
          <AgentToggle sessionId={sessionId} agent={agent} hasChildren={hasChildren} collapsed={collapsed} />
          {depth > 0 && <span class="h-4 w-px bg-base-content/20" aria-hidden="true" />}
          <Icon name={AGENT_ICON[agent.kind]} class="icon icon-xs text-base-content/60" />
          <span class="tree-name truncate font-medium" title={label}>
            {label}
          </span>
          {agent.agentType !== null && (
            <span class="tree-type badge badge-ghost badge-sm font-mono">{agent.agentType}</span>
          )}
        </div>
      </td>
      <td class="min-w-0">
        {agent.model !== null ? (
          <ModelChip model={agent.model} />
        ) : (
          <span class="text-base-content/60">–</span>
        )}
      </td>
      <td class="num text-right">{fmtNum(agent.requests)}</td>
      <td class="num text-right">{fmtTokens(totalTokens(agent.tokens))}</td>
      <AgentCostCell cost={agent.costUsd} />
      <AgentP95Cell p95={agent.latencyP95} />
      <AgentLastCell at={agent.lastAt} />
    </TableRow>
  );
}

/** A subagent that never ran: no request and no tool call, so its row carries nothing but a name. */
function isEmptySubagent(agent: AgentView): boolean {
  return agent.kind === "subagent" && agent.requests === 0 && agent.tools === 0;
}

/** The bottom-of-table toggle for a session's never-ran subagents; hidden until asked for. */
function EmptyToggle({ sessionId, count, shown }: { sessionId: string; count: number; shown: boolean }) {
  const { act } = useApp();
  return (
    <button
      type="button"
      class="tree-empty btn btn-ghost btn-sm"
      data-action="empty-agents"
      data-value={sessionId}
      aria-expanded={shown ? "true" : "false"}
      onClick={() => act("empty-agents", sessionId)}
    >
      {shown ? "Hide" : "Show"} {fmtNum(count)} empty {count === 1 ? "agent" : "agents"}
    </button>
  );
}

/** Agents of one session as table rows: parents above children by depth, jobs at the bottom with their
 *  own subagents nested under them, empties behind the toggle. `onPick`/`activeId` open the transcript
 *  slide-over and light the narrowed row; both views pass them. */
export function agentRows(
  sessionId: string,
  agents: AgentView[],
  collapsed: Set<string>,
  showEmpty: boolean,
  onPick?: ((agent: AgentView) => void) | undefined,
  activeId?: string | null | undefined,
): ComponentChildren[] {
  const locals = agents.filter((a) => a.kind !== "external" && (showEmpty || !isEmptySubagent(a)));
  const byParent = new Map<string, AgentView[]>();
  for (const agent of locals) {
    const key = agent.parentId ?? "";
    const list = byParent.get(key) ?? [];
    list.push(agent);
    byParent.set(key, list);
  }
  const renderNode = (agent: AgentView, depth: number): ComponentChildren[] => {
    const kids = [...(byParent.get(agent.id) ?? [])].sort(compareAgents);
    const rowCollapsed = collapsed.has(`${sessionId}/${agent.id}`);
    return [
      <AgentRow
        key={agent.id}
        sessionId={sessionId}
        agent={agent}
        depth={depth}
        hasChildren={kids.length > 0}
        collapsed={rowCollapsed}
        active={activeId === agent.id}
        onPick={onPick}
      />,
      // a collapsed agent's whole subtree stays out of the table
      ...(rowCollapsed ? [] : kids.flatMap((kid) => renderNode(kid, depth + 1))),
    ];
  };
  const rows = [...(byParent.get("") ?? [])].sort(compareAgents).flatMap((root) => renderNode(root, 0));
  const external = agents.filter((a) => a.kind === "external");
  if (external.length > 0) {
    rows.push(
      <tr key="external">
        <th
          colSpan={AGENT_COLUMNS.length}
          class="tree-section bg-base-200/60 px-4 py-2.5 text-left text-sm font-medium text-base-content/70"
          scope="colgroup"
        >
          {`Jobs (${fmtNum(external.length)})`}
        </th>
      </tr>,
    );
    for (const agent of external) {
      // a job's subagents (their transcripts remap onto the job's id) are keyed under it in byParent,
      // unreachable from the roots: they render here, nested under the job they ran under
      const kids = [...(byParent.get(agent.id) ?? [])].sort(compareAgents);
      const rowCollapsed = collapsed.has(`${sessionId}/${agent.id}`);
      rows.push(
        <AgentRow
          key={agent.id}
          sessionId={sessionId}
          agent={agent}
          depth={0}
          hasChildren={kids.length > 0}
          collapsed={rowCollapsed}
          active={activeId === agent.id}
          onPick={onPick}
        />,
      );
      if (!rowCollapsed) rows.push(...kids.flatMap((kid) => renderNode(kid, 1)));
    }
  }
  const empty = agents.filter(isEmptySubagent);
  if (empty.length > 0) {
    rows.push(
      <tr key="empty">
        <td colSpan={AGENT_COLUMNS.length} class="px-4 py-2">
          <EmptyToggle sessionId={sessionId} count={empty.length} shown={showEmpty} />
        </td>
      </tr>,
    );
  }
  return rows;
}

/** A session's head row: chevron, name, live badge and its totals; clicking collapses the whole block. */
function SessionHead({ target, collapsed }: { target: SessionListItem; collapsed: boolean }) {
  const { act } = useApp();
  const value = `${target.id}/`;
  const cost = target.costUsd;
  return (
    <button
      type="button"
      class="flex w-full flex-wrap items-center gap-3 border-b border-base-content/8 px-5 py-3.5 text-left hover:bg-base-200/60"
      data-action="collapse"
      data-value={value}
      aria-expanded={collapsed ? "false" : "true"}
      onClick={() => act("collapse", value)}
    >
      <Icon name={collapsed ? "chevronRight" : "chevronDown"} class="icon text-base-content/60" />
      <span class="tree-head-name truncate font-semibold">{sessionName(target)}</span>
      {target.live ? (
        <span class="badge badge-success badge-soft">
          <span class="status status-success neon-dot motion-safe:animate-ping" aria-hidden="true" />
          Live
        </span>
      ) : (
        <span class="badge badge-ghost">Ended</span>
      )}
      <span class="tree-head-facts ml-auto flex gap-4 text-right whitespace-nowrap text-meta text-base-content/60">
        <span>{fmtCount(target.agentCount, "agent")}</span>
        <span>{fmtCount(target.requestCount, "request")}</span>
        <span class="num font-semibold text-base-content">{fmtTokens(target.tokens)}</span>
        {cost !== undefined && cost !== null && (
          <span class="tree-head-cost num text-base-content">{fmtUsd(cost)}</span>
        )}
      </span>
    </button>
  );
}

/** The agents tab: each session's agents as one table, Main first, nesting by spawn depth. A row click
 *  opens the agent's live transcript in the slide-over. */
export function AgentsView() {
  const { state, act } = useApp();
  const targets = detailTargets(state);
  if (targets.length === 0) {
    return (
      <Panel icon="bot" title="Agents">
        <EmptyState
          title="No agents to show"
          hint="Each session's main agent and its subagents appear here as they run."
          icon="bot"
        />
      </Panel>
    );
  }
  return (
    <div class="grid gap-5">
      {targets.map((target) => {
        const collapsed = state.collapsed.has(`${target.id}/`);
        const detail: SessionView | undefined = state.details[target.id];
        let body: ComponentChildren = null;
        if (!collapsed) {
          if (detail === undefined)
            body = (
              <p class="tree-note px-5 py-4 text-sm text-base-content/60">Loading this session's agents…</p>
            );
          else if (detail.agents.length === 0) {
            body = (
              <p class="tree-note px-5 py-4 text-sm text-base-content/60">
                No agents recorded for this session yet.
              </p>
            );
          } else
            body = (
              <Table columns={AGENT_COLUMNS}>
                <TableHeadStatic columns={AGENT_COLUMNS} />
                <tbody>
                  {agentRows(
                    detail.id,
                    detail.agents,
                    state.collapsed,
                    state.emptyAgents.has(target.id),
                    (agent) => act("agent-transcript", agentNodeId(target.id, agent)),
                  )}
                </tbody>
              </Table>
            );
        }
        return (
          <Panel key={target.id} flush class="tree-block">
            <SessionHead target={target} collapsed={collapsed} />
            {body}
          </Panel>
        );
      })}
    </div>
  );
}
