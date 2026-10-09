#!/usr/bin/env bun
// PostToolUse and UserPromptSubmit: bring the new messages of this session's channels into its
// context (bin/feed.ts), so every session knows what the others said, also to each other, without
// the channels preview. Silent when nothing is new, no channel is set, the session holds no
// credential for the server (it has not joined), Huddle does not answer, or anything fails
// (quiet.ts). A subagent's tool calls (agent_id set) are skipped: the feed's cursor is the
// session's, and a subagent reading it would take the messages away from its parent (subagents
// read the channel through recall and their brief). When the session just asked for a dashboard
// link (`huddle open`, or a `huddle join … --token` inside Claude Code: creds.ts requestLink) or
// an invite (/huddle:invite: creds.ts requestInvite), it mints one and shows it in systemMessage —
// to the user, not Claude: a login code and an invite are secrets. An edit (Edit, Write, MultiEdit,
// NotebookEdit: bin/touch.ts) is reported as its repo-relative path, also from a subagent (as its
// session's); when another live session edited the same file lately, one line says so.
import { identity } from "../bin/identity";
import { home, dashboard, invite } from "../bin/serve";
import { takeLinkRequest, takeInviteRequest } from "../bin/creds";
import { feed } from "../bin/feed";
import { touchOf, reportTouch } from "../bin/touch";
import { run } from "./quiet";
import { sleep, stdinText, stdoutWrite } from "../server/src/rt";

await run("listen", async () => {
  const input = await Promise.race([stdinText(), sleep(500).then(() => "")]).then(t => JSON.parse(t || "{}")).catch(() => ({})) as { session_id?: string; hook_event_name?: string; agent_id?: string; tool_name?: string; tool_input?: unknown; cwd?: string };
  if (input.session_id) process.env.HUDDLE_SESSION = String(input.session_id); // the key of this session's credential (creds.ts)
  const t = touchOf(input as any);
  const id = (input.agent_id && !t) ? null : identity();
  if (!id?.channel || !id.as) return;
  const warned = t ? reportTouch(id, t, 1000) : Promise.resolve("");
  if (input.agent_id) { // a subagent's tool call: the parent's feed is not its to take, its edits are
    const w = await warned;
    if (w) await stdoutWrite(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? "PostToolUse", additionalContext: w } }) + "\n");
    return;
  }
  const asked = takeLinkRequest(input.session_id), wants = takeInviteRequest(input.session_id);
  const [feedText, link, inv, warn] = await Promise.all([
    feed(id, home(), String(input.session_id ?? ""), { cli: "huddle" }),
    asked ? dashboard(id.url, input.session_id, 1500) : null,
    wants ? invite(id.url, wants, input.session_id, 1500) : null, warned]);
  const text = [warn, feedText].filter(Boolean).join("\n\n");
  const user: string[] = [];
  if (asked) user.push(link ? `Huddle dashboard (signs your browser in once, within 5 min; expired? /huddle:open makes another): ${link}`
    : "Huddle: no dashboard link this time (the server did not answer, or this session has not joined); try /huddle:open again.");
  if (inv) user.push(inv.ok ? `Huddle: to add another Claude session, paste into it: /huddle:join ${new URL(id.url).host} --token ${inv.token}  (${inv.expires ? `valid until ${inv.expires}` : "never expires"}${wants?.single_use ? ", single use" : ""})`
    : `Huddle: no invite this time (${inv.error}); try /huddle:invite again.`);
  if (text || user.length) await stdoutWrite(JSON.stringify({ ...(user.length ? { systemMessage: user.join("\n") } : {}),
    ...(text ? { hookSpecificOutput: { hookEventName: input.hook_event_name ?? "PostToolUse", additionalContext: text } } : {}) }) + "\n");
});
