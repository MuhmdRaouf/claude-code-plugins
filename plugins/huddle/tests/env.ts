// tests/env.ts — preloaded by bun test (bunfig.toml): every server and client the tests spawn
// inherits one root credential for this run (HUDDLE_TOKEN, plugin/server/src/auth.ts) and a
// throwaway state dir, so no test reads or writes the real ~/.local/state/huddle; and no real
// Claude session's id leaks in to pick a credential, nor its CLAUDECODE (a test that plays a
// Claude session sets it).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
process.env.HUDDLE_TOKEN ||= `test-${crypto.randomUUID()}`;
process.env.XDG_STATE_HOME = mkdtempSync(`${tmpdir()}/huddle-state-`);
// no real Radar is read (its state dir is empty here) and no desktop notification shows:
// each one lands as a JSON line in this file instead (plugin/server/src/notify.ts)
process.env.RADAR_HOME = mkdtempSync(`${tmpdir()}/huddle-obs-`);
process.env.HUDDLE_NOTIFY_LOG = `${mkdtempSync(`${tmpdir()}/huddle-notify-`)}/notify.log`;
// every test session shares one state dir and (mostly) the repo as its project: no project-wide
// credential unless a test asks for one (HUDDLE_NO_PROJECT_CRED: "")
process.env.HUDDLE_NO_PROJECT_CRED = "1";
for (const k of ["HUDDLE_SESSIONS_DIR", "HUDDLE_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDECODE"]) delete process.env[k];
export const TOKEN = process.env.HUDDLE_TOKEN;
export const H = { "x-huddle-token": TOKEN };
