// src/mcp.ts — Huddle as an MCP server (Streamable HTTP, JSON responses), at
//   POST /mcp/<channel>?as=<session>        (or headers x-huddle-channel / x-huddle-as)
// Tools are src/ops.ts. A blocking tool (wait, gate, wait_task) is cancelled when the client
// sends notifications/cancelled or drops the request. Server→client pushes (claude/channel
// wake-ups) go through bin/huddle-mcp, the stdio bridge, which reads GET /api/c/<ch>/live.
import { HuddleError, type Row } from "./channel";
import type { Hub } from "./hub";
import { runOp, toolDefs } from "./ops";

import { readFileSync } from "node:fs";
import { PLUGIN } from "./rt";
// one version: the plugin's (.claude-plugin/plugin.json)
export const VERSION: string = (() => { try { return JSON.parse(readFileSync(`${PLUGIN}/.claude-plugin/plugin.json`, "utf8")).version ?? "dev"; } catch { return "dev"; } })();
export const instructions = (ch: string, me: string) => `You are "${me}" in Huddle channel "${ch}": every session (and subagent) in this channel sees the same events, tasks and shared knowledge, so act as one team.
Protocol (the huddle skill has the full version):
1. You are already joined (the session start did it): call status to refresh; join only to change your role or context. Tools are mcp__plugin_huddle_huddle__<op>; from Bash, \`huddle <op>\`.
2. recall before reading files or re-deriving anything; remember what you learn (fact, lesson, decision, context, result, howto).
3. gate before any change (paused = stop). Answer every inbox message with reply.
4. Work: start (takes your next task, or the id you name) → do it → finish "<command + result>" (releases what waited on it, names your next). When start says the task waits on another session's: wait with topics ["task.ready"] (or wait_task) instead of polling or guessing.
5. Need someone else: send (ask=true for a reply), or task_create with owner and after. Ping-pong work: only the turn holder acts; pass the turn when done.
6. Idle or blocked on others: wait (it returns kind message | event | timeout; on event, handle it and its skipped list, then ack its seq; on timeout, wait again).
7. Subagents you start: they join as "${me}.<role>" (pass as), share results with remember, and leave when done.`;

type Msg = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Row };

// one line instead of a JSON object, for the ops that have no text of their own (an agent's context
// pays for every byte; json: true still returns the whole object). Anything unexpected: JSON.
const ev = (e: Row) => `#${e.seq} ${e.from} → ${e.to ?? "all"} (${e.topic}): ${String(e.msg ?? "").slice(0, 400)}`;
const SHORT: Record<string, (r: any) => string | null> = {
  send: r => r?.seq ? `#${r.seq} sent to ${r.to ?? "everyone"}${r.needs_reply ? " (an ask: it waits for a reply)" : ""}` : null,
  publish: r => r?.seq ? `#${r.seq} published (${r.topic}) to ${r.to ?? "everyone"}` : null,
  reply: r => r?.seq ? `#${r.seq} replied` : null,
  remember: r => r?.id ? `#${r.id} remembered: ${r.title}` : null,
  task_create: r => r?.task?.id ? `created ${r.task.id} → ${r.task.owner ?? "unowned"} (${r.task.ready ? "ready" : `waits on ${(r.task.unmet ?? []).map((u: Row) => u.id).join(", ")}`})` : null,
  finish: r => r?.done ? `done ${r.done}; released: ${r.released?.length ? r.released.map((x: Row) => `${x.task}→${x.to ?? "?"}`).join(", ") : "none"}${r.knowledge ? `; result #${r.knowledge}` : ""}; next: ${r.next ? `${r.next.id} ${r.next.title}${r.next.ready ? "" : ` (waits on ${(r.next.unmet ?? []).join(", ")})`}` : "none"}` : null,
  wait: r => r?.kind === "timeout" ? "timeout: call wait again" : r?.kind && r.seq ? [`${r.kind}: ${ev(r)}${r.needs_reply ? ` [answer: reply seq=${r.seq}]` : ""}${r.more ? ` (+${r.more} more waiting)` : ""} — ack ${r.seq} once handled`, ...(r.skipped ?? []).map((e: Row) => `  skipped ${ev(e)}`), ...(r.skipped_total > (r.skipped?.length ?? 0) ? [`  (${r.skipped_total - r.skipped.length} older skipped: events)`] : [])].join("\n") : null,
};
const inflight = new Map<string, AbortController>();

export async function mcpHandle(hub: Hub, channel: string, conn: string, m: Msg, signal?: AbortSignal): Promise<Msg | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0" as const, id: m.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0" as const, id: m.id ?? null, error: { code, message } }) as Msg;
  const key = `${channel}/${conn}/${String(m.params?.requestId ?? m.id)}`;
  if (m.method === "notifications/cancelled") { inflight.get(key)?.abort(); return null; }
  if (m.id === undefined || m.id === null) return null; // other notifications
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {}, experimental: { "claude/channel": {} } },
        serverInfo: { name: "huddle", version: VERSION }, instructions: instructions(channel, conn) });
    case "ping": return reply({});
    case "tools/list": return reply({ tools: toolDefs() });
    case "tools/call": {
      const ac = new AbortController();
      inflight.set(key, ac);
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort);
      try {
        const ch = await hub.get(channel);
        // an agent that passes a short timeout burns a turn per wake-up: blocking tools wait ≥ 60 s
        const args = { ...(m.params?.arguments ?? {}) };
        if (["wait", "wait_task", "depend", "handoff", "ask_wait"].includes(String(m.params?.name)) && args.timeout !== undefined) args.timeout = Math.max(60, Number(args.timeout) || 0);
        const { result, text } = await runOp(String(m.params?.name ?? ""), ch, conn, args, { signal: ac.signal, waitDefault: 240 });
        const name = String(m.params?.name ?? "");
        const short = text ?? (args.json ? null : (() => { try { return SHORT[name]?.(result) ?? null; } catch { return null; } })());
        return reply({ content: [{ type: "text", text: short ?? JSON.stringify(result, null, 1) }] });
      } catch (e) {
        const err = e as HuddleError;
        if (err.status === 404 && /no operation/.test(err.message)) return fail(-32602, err.message);
        return reply({ content: [{ type: "text", text: `huddle: ${err.message}` }], isError: true });
      } finally { inflight.delete(key); signal?.removeEventListener("abort", onAbort); }
    }
    case "resources/list": return reply({ resources: [] });
    case "prompts/list": return reply({ prompts: [] });
  }
  return fail(-32601, `method not found: ${m.method}`);
}
