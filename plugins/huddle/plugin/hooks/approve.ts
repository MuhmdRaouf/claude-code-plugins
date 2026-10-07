#!/usr/bin/env bun
// PreToolUse (Bash): the channel's approval rules (server/src/rules.ts; the owner switches them in
// the dashboard's Settings). A command that matches no rule ends here, before any network or file
// read: silent, the normal permission flow goes on. One that could match asks the server, which
// knows which rules this channel has on; on a match it records an approval.request event (the
// owner's Inbox and a desktop notification) and this hook answers Claude Code's native
// permissionDecision "ask" with a short reason: Claude Code shows its own permission prompt, and
// the user decides there. It never denies and never waits. Silent when the session is not in a
// huddle (no channel, no credential: 401), when Huddle does not answer within its deadline, or
// when anything fails (quiet.ts). The command is sent to the local server only, never stored,
// logged or shown.
import { matching } from "../server/src/rules";
import { run } from "./quiet";
import { sleep, stdinText, stdoutWrite } from "../server/src/rt";

await run("approve", async () => {
  const input = await Promise.race([stdinText(), sleep(300).then(() => "")]).then(t => JSON.parse(t || "{}")).catch(() => ({})) as
    { session_id?: string; tool_name?: string; tool_input?: { command?: unknown } };
  if (input.tool_name && input.tool_name !== "Bash") return;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (!matching(command).length) return; // no rule could apply: nothing to ask anyone
  if (input.session_id) process.env.HUDDLE_SESSION = String(input.session_id); // the key of this session's credential (creds.ts)
  const { identity, hfetch } = await import("../bin/identity");
  const id = identity();
  if (!id.channel || !id.as || !id.url) return; // not in a huddle: silent
  const r = await hfetch(`${id.url}/api/c/${encodeURIComponent(id.channel)}/x/approval?as=${encodeURIComponent(id.as)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, claude_session: input.session_id }), signal: AbortSignal.timeout(600) }); // the whole hook stays under a second
  if (!r.ok) return; // 401 (not joined), 404 (no such session or channel), anything else: silent
  const j = await r.json() as { ask?: boolean; reason?: string };
  if (j.ask !== true) return;
  await stdoutWrite(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask",
    permissionDecisionReason: String(j.reason ?? "Huddle: the owner asked to approve this command").slice(0, 300) } }) + "\n");
});
