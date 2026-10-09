import type { ActivityRow } from "../app/activity.ts";
import { isEngineTool } from "../domain/engine.ts";
import type { Provider } from "../domain/provider.ts";
import { ago, count, plural, table } from "./format.ts";

/** The state a row shows: active, idle, or a job's own state — in review, the verdict it will be accepted against
 *  (the label the job board always printed); a dead driver marks it stale, and a running engine shows its pid. */
function stateLabel(row: ActivityRow): string {
  const isJob = row.kind !== "subagent" && row.kind !== "session";
  if (isJob && row.state === "awaiting_review") return `review: ${row.verdict ?? "no verdict"}`;
  const stale = row.stale === true ? " (stale)" : "";
  const pid = row.pid === undefined ? "" : ` (pid ${row.pid})`;
  return `${row.state}${stale}${pid}`;
}

/** The live board: one table of what runs on the provider right now — subagents and sessions the router served,
 *  beside the job store's jobs — active first, then newest first. */
export function board(provider: Provider, rows: readonly ActivityRow[], now: number): string {
  if (rows.length === 0)
    return `No ${provider.display} activity yet. After ${provider.slash}setup, the sessions and subagents on its models appear here.`;
  const lines = table([
    ["KIND", "ID", "MODEL", "STATE", "REQ", "IN", "OUT", "LAST", "TITLE"],
    ...rows.map((row) => [
      row.kind,
      row.id,
      row.model ?? "-",
      stateLabel(row),
      row.requests === undefined ? "-" : String(row.requests),
      row.inputTokens === undefined ? "-" : count(row.inputTokens),
      row.outputTokens === undefined ? "-" : count(row.outputTokens),
      ago(row.at, now),
      row.title ?? "-",
    ]),
  ]);
  return [...lines, ...engineNote(rows), ...staleNote(provider, rows)].join("\n");
}

/** omp, opencode and pi run on their own setup: their rows carry the tool's own report, and say so. */
function engineNote(rows: readonly ActivityRow[]): readonly string[] {
  const tools = [...new Set(rows.map((row) => row.kind).filter((kind) => isEngineTool(kind)))];
  if (tools.length === 0) return [];
  return [
    "",
    `${tools.join(", ")} rows: model and numbers as the tool itself reports them (it runs on its own setup).`,
  ];
}

function staleNote({ slash }: Provider, rows: readonly ActivityRow[]): readonly string[] {
  const ids = rows.filter((row) => row.stale === true).map((row) => row.id);
  if (ids.length === 0) return [];
  return [
    "",
    `stale: ${plural(ids.length, "job has", "jobs have")} no live driver (${ids.join(", ")}); stopping one here moves it to review, where ${slash}review <id> discards it.`,
  ];
}

/** How many review ids the SessionStart line names before it says how many more there are. */
const HOOK_IDS = 3;

/** SessionStart line: what needs the reviewer, what is still running; empty when nothing does. It goes into Claude's
 *  context every session, so it stays one short line: at most three ids, each with the slash command that decides it. */
export function hook({ name, slash }: Provider, rows: readonly ActivityRow[]): string {
  const review = rows.filter((row) => row.state === "awaiting_review").map((row) => row.id);
  const named = review.slice(0, HOOK_IDS).map((id) => `${slash}review ${id}`);
  const more = review.length > HOOK_IDS ? ` and ${review.length - HOOK_IDS} more` : "";
  const active = rows.filter((row) => ["queued", "running", "verifying"].includes(row.state)).length;
  const parts = [
    ...(review.length === 0
      ? []
      : [`${plural(review.length, "job awaits", "jobs await")} review (${named.join(", ")}${more})`]),
    ...(active === 0 ? [] : [`${plural(active, "job")} queued or running`]),
  ];
  return parts.length === 0 ? "" : `${name}: ${parts.join("; ")}. ${slash}board lists them.`;
}
