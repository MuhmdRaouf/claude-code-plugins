#!/usr/bin/env bun
// PostToolUse and UserPromptSubmit: bring the new messages of this session's channels into its
// context (bin/feed.ts), so every session knows what the others said, also to each other, without
// the channels preview. Silent when nothing is new, no channel is set, the session holds no
// credential for the server (it has not joined), Huddle does not answer, or anything fails
// (quiet.ts). A subagent's tool calls (agent_id set) are skipped: the feed's cursor is the
// session's, and a subagent reading it would take the messages away from its parent (subagents
// read the channel through recall and their brief). An edit (Edit, Write, MultiEdit,
// NotebookEdit: bin/touch.ts) is reported as its repo-relative path, also from a subagent (as its
// session's); when another live session edited the same file lately, one line says so.
import { identity } from "../bin/identity";
import { home } from "../bin/serve";
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
  const [feedText, warn] = await Promise.all([
    feed(id, home(), String(input.session_id ?? ""), { cli: "huddle" }), warned]);
  const text = [warn, feedText].filter(Boolean).join("\n\n");
  if (text) await stdoutWrite(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? "PostToolUse", additionalContext: text } }) + "\n");
});
