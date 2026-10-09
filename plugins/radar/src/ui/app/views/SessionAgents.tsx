/**
 * The Agents tab of a picked session: one table with Main first, then its subagents nested by spawn depth,
 * then the jobs the session submitted — live rows first, ended ones dimmed with a word for when. Picking a
 * row opens the agent's live transcript in the slide-over, whose "Show its requests" narrows Requests,
 * Tools and Timeline to that agent.
 */

import type { SessionView } from "../../../shared/model.ts";
import { fmtCount } from "../../fmt.ts";
import { agentNodeId, selectedSession } from "../../state.ts";
import { useApp } from "../context.ts";
import { EmptyState, Panel } from "../kit.tsx";
import { Table, TableHeadStatic } from "../table.tsx";
import { AGENT_COLUMNS, agentRows } from "./Agents.tsx";

/** The session's agents as the tab's one table; the detail arrives on demand, as on the fleet view. */
export function SessionAgentsTable({ detail }: { detail: SessionView }) {
  const { state, act } = useApp();
  return (
    <Table dataKey="session-agents" columns={AGENT_COLUMNS}>
      <TableHeadStatic columns={AGENT_COLUMNS} />
      <tbody>
        {agentRows(
          detail.id,
          detail.agents,
          state.collapsed,
          state.emptyAgents.has(detail.id),
          (agent) => act("agent-transcript", agentNodeId(detail.id, agent)),
          state.agent,
        )}
      </tbody>
    </Table>
  );
}

/** The Agents tab while a session is picked: the session's own table, no per-session blocks. */
export function SessionAgentsView() {
  const { state } = useApp();
  const item = selectedSession(state);
  if (item === null) return null; // the shell only mounts this view when a session is picked
  const detail = state.details[item.id];
  const live = detail?.agents.filter((agent) => agent.live).length ?? null;
  return (
    <Panel
      icon="bot"
      flush
      title="Agents"
      subtitle={live === null ? "Loading…" : fmtCount(detail?.agents.length ?? 0, "agent")}
    >
      {detail === undefined ? (
        <p class="px-5 py-4 text-sm text-base-content/60">Loading this session's agents…</p>
      ) : detail.agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          hint="The session's main agent appears here as soon as it makes a request; subagents join it as they spawn."
          icon="bot"
        />
      ) : (
        <SessionAgentsTable detail={detail} />
      )}
    </Panel>
  );
}
