// tests/hooks.test.ts — the hooks run inside every session and must never block one: exit 0, back
// within the hooks.json timeout (their own internal deadlines sit at most 70 % inside it), never
// exit 2, never a blocking decision — the Stop hook's deliberate block, only while asks await a
// reply, excepted. Every hook runs as a child process (bun, exactly as hooks.json runs it) against
// a Huddle that is down, slow (accepts and never answers), answers garbage, or with odd env; the
// block cases run against the real server.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { H } from "./env";

const ROOT = `${import.meta.dir}/..`;
const HOOKS = (JSON.parse(await Bun.file(`${ROOT}/plugin/hooks/hooks.json`).text()) as any).hooks;
/** The timeout Claude Code grants each event, in ms — the hook is dead to it after that. */
const ms = (event: string) => HOOKS[event][0].hooks[0].timeout * 1000;

// a port nothing listens on → Huddle is down
import { freePort, startServer } from "./net";
const DOWN = `http://127.0.0.1:${await freePort()}`;
const mute = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: () => new Promise(() => {}) }); // accepts, never answers
const garbage = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<h1>not json</h1>") });
const wrongShape = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ result: 42, text: "garbled" }) });
const MUTE = `http://127.0.0.1:${mute.port}`, GARBAGE = `http://127.0.0.1:${garbage.port}`, WRONG = `http://127.0.0.1:${wrongShape.port}`;

/** Run one hook as a child process in a throwaway world: cwd and HUDDLE_HOME in a temp dir, so no real huddle.json or seen state is read or written. */
const run = async (hook: string, input: unknown, env: Record<string, string>) => {
  const world = mkdtempSync(`${tmpdir()}/huddle-hook-`);
  const t0 = Date.now();
  const p = Bun.spawn(["bun", `${ROOT}/plugin/hooks/${hook}`], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: world, HUDDLE_HOME: world, HUDDLE_DATA: "", HUDDLE_LISTEN: "", HUDDLE_CONTEXT: "", HUDDLE_AUTOSTART: "0", ...env },
    cwd: world, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(p.stdout).text();
  const stderr = await new Response(p.stderr).text();
  return { exitCode: await p.exited, stdout, stderr, ms: Date.now() - t0, world };
};

/** Whatever a hook prints must be context (hookSpecificOutput), never a decision. */
const neverBlocks = (stdout: string) => {
  if (!stdout.trim()) return;
  expect(JSON.parse(stdout).decision).toBeUndefined();
};

/** Which events each hook serves (for the deadline check against hooks.json). */
const EVENTS: Record<string, string[]> = {
  "listen.ts": ["PostToolUse", "UserPromptSubmit"],
  "session-start.ts": ["SessionStart"],
  "stop.ts": ["Stop"],
  "approve.ts": ["PreToolUse"],
};

test("hooks.json: matcher groups of guarded command hooks (bun, else node, on dist/), deadlines at most 70 % inside each timeout", async () => {
  expect(Object.keys(HOOKS).sort()).toEqual(["PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"].sort());
  for (const groups of Object.values(HOOKS))
    for (const g of groups) {
      expect(Array.isArray(g.hooks)).toBe(true);
      for (const h of g.hooks) {
        expect(h.type).toBe("command");
        // neither bun nor node on Claude Code's PATH: exit 0 at once; a crash of the runtime itself: exit 0, nothing on stderr
        expect(h.command).toMatch(/^R=\$\(command -v bun \|\| command -v node\) \|\| exit 0; "\$R" "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/[a-z-]+\.js" 2>\/dev\/null \|\| exit 0$/);
        // the bundle it runs is built from the hook's source (scripts/build.mjs)
        const js = /dist\/([a-z-]+)\.js/.exec(h.command)![1];
        expect(readFileSync(`${ROOT}/plugin/dist/${js}.js`, "utf8")).toContain(`generated from plugin/hooks/${js}.ts`);
        expect(h.timeout).toBeGreaterThan(0);
      }
    }
  for (const [script, events] of Object.entries(EVENTS)) {
    const src = await Bun.file(`${ROOT}/plugin/hooks/${script}`).text();
    const deadlines = [...src.matchAll(/AbortSignal\.timeout\((\d+)\)/g)].map((m) => Number(m[1]));
    for (const d of deadlines) for (const e of events) expect(d, `${script} deadline vs ${e}`).toBeLessThanOrEqual(0.7 * ms(e));
  }
});

test("the listen hook: down, slow, garbage or wrong-shape Huddle — exit 0, no decision, inside the deadline", async () => {
  for (const url of [DOWN, MUTE, GARBAGE, WRONG]) {
    const r = await run("listen.ts", { session_id: "s-1", hook_event_name: "PostToolUse" }, { HUDDLE_URL: url, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "me" });
    expect(r.exitCode, url).toBe(0);
    expect(r.ms, url).toBeLessThan(0.7 * ms("PostToolUse"));
    neverBlocks(r.stdout);
  }
}, 30_000);

test("the listen hook answers UserPromptSubmit the same way", async () => {
  const r = await run("listen.ts", { session_id: "s-1", hook_event_name: "UserPromptSubmit" }, { HUDDLE_URL: MUTE, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "me" });
  expect(r.exitCode).toBe(0);
  expect(r.ms).toBeLessThan(0.7 * ms("UserPromptSubmit"));
  neverBlocks(r.stdout);
}, 15_000);

test("the listen hook survives odd env", async () => {
  const home = join(mkdtempSync(`${tmpdir()}/huddle-hook-`), "home");
  writeFileSync(home, "a file, not a dir"); // the seen state cannot be written
  const odd = [
    { HUDDLE_URL: "::::", HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "me" }, // not a URL
    { HUDDLE_URL: "http://", HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "me" }, // no host
    { HUDDLE_URL: GARBAGE, HUDDLE_CHANNEL: "unclosed[", HUDDLE_AS: "me", HUDDLE_WAIT: "banana", HUDDLE_LISTEN: " , x ," },
    { HUDDLE_URL: GARBAGE, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "me", HUDDLE_HOME: home },
    { HUDDLE_URL: GARBAGE, HUDDLE_CHANNEL: "", HUDDLE_AS: "me" }, // no channel: silent at once
  ];
  for (const env of odd) {
    const r = await run("listen.ts", { session_id: "s-1", hook_event_name: "PostToolUse" }, env);
    expect(r.exitCode, JSON.stringify(env)).toBe(0);
    expect(r.ms, JSON.stringify(env)).toBeLessThan(0.7 * ms("PostToolUse"));
    neverBlocks(r.stdout);
  }
}, 30_000);

test("the session-start hook: no channel, down, garbage — exit 0, no decision", async () => {
  const none = await run("session-start.ts", { source: "startup" }, { HUDDLE_URL: DOWN, HUDDLE_CHANNEL: "", HUDDLE_AS: "" });
  expect(none.exitCode).toBe(0);
  expect(none.stdout).toBe("");
  for (const url of [DOWN, GARBAGE, WRONG, "::::"]) {
    const r = await run("session-start.ts", { source: "startup" }, { HUDDLE_URL: url, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "me" });
    expect(r.exitCode, url).toBe(0);
    expect(r.ms, url).toBeLessThan(0.7 * ms("SessionStart"));
    neverBlocks(r.stdout);
  }
}, 30_000);

test("the session-start hook gives up on a Huddle that never answers, inside its 3 s budget", async () => {
  const r = await run("session-start.ts", { source: "startup" }, { HUDDLE_URL: MUTE, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "me" });
  expect(r.exitCode).toBe(0);
  expect(r.ms).toBeLessThan(5000); // the 3 s budget plus bun's start, far inside the timeout
  neverBlocks(r.stdout); // it says the service does not answer — context, not a decision
}, 30_000);

test("the session-start hook with autostart keeps to its 3 s budget even when the server it starts cannot answer", async () => {
  const r = await run("session-start.ts", { source: "startup" }, { HUDDLE_URL: MUTE, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "me", HUDDLE_AUTOSTART: "1" });
  try { process.kill(Number(readFileSync(`${r.world}/huddle.pid`, "utf8")), "SIGTERM"); } catch {} // the server it started (the port is taken: it exits on its own)
  expect(r.exitCode).toBe(0);
  expect(r.ms).toBeLessThan(5500);
  neverBlocks(r.stdout);
}, 30_000);

test("the hooks.json commands exit 0 in silence when neither bun nor node is on Claude Code's PATH", async () => {
  for (const [event, groups] of Object.entries(HOOKS) as [string, any[]][]) {
    const p = Bun.spawn(["/bin/sh", "-c", groups[0].hooks[0].command], { env: { PATH: "/var/empty", CLAUDE_PLUGIN_ROOT: `${ROOT}/plugin` }, stdin: new Blob(["{}"]), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code, event).toBe(0);
    expect(out + err, event).toBe("");
  }
});

test("a hook that throws logs the error to hooks.log and exits 0 in silence", async () => {
  const world = mkdtempSync(`${tmpdir()}/huddle-hook-`);
  const p = Bun.spawn(["bun", "-e", `import { run } from "${ROOT}/plugin/hooks/quiet.ts"; await run("probe", async () => { throw new Error("kaboom"); });`],
    { env: { ...process.env, HUDDLE_HOME: world, CLAUDE_PROJECT_DIR: world }, cwd: world, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(out + err).toBe("");
  expect(readFileSync(`${world}/hooks.log`, "utf8")).toContain("probe: kaboom");
});

// the real server, for the Stop hook's one deliberate block
let U = "";
let srv: Subprocess;
beforeAll(async () => {
  const s = await startServer({ HUDDLE_DATA: mkdtempSync(`${tmpdir()}/huddle-stop-`) });
  srv = s.p; U = s.u;
}, 40_000);
afterAll(async () => {
  srv.kill(); await srv.exited;
  mute.stop(true); garbage.stop(true); wrongShape.stop(true);
}, 20_000);

const op = async (ch: string, name: string, as: string, body: unknown = {}) =>
  (await (await fetch(`${U}/api/c/${ch}/op/${name}?as=${as}`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as any;

test("the stop hook blocks exactly while asks await a reply", async () => {
  await op("hooks", "join", "senior"); await op("hooks", "join", "me"); await op("hooks", "join", "quiet");
  await op("hooks", "send", "senior", { to: "me", msg: "did you finish the migration?", ask: true });
  const r = await run("stop.ts", {}, { HUDDLE_URL: U, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "me" });
  expect(r.exitCode).toBe(0);
  expect(r.ms).toBeLessThan(ms("Stop"));
  const j = JSON.parse(r.stdout);
  expect(j.decision).toBe("block");
  expect(j.reason).toContain("did you finish the migration?");
}, 30_000);

test("the stop hook blocks once per ask, never again for the same one, and never for a stale one", async () => {
  await op("hooks", "join", "twice");
  await op("hooks", "send", "senior", { to: "twice", msg: "still there?", ask: true });
  const home = mkdtempSync(`${tmpdir()}/huddle-stop-home-`); // one Huddle home across the runs, like one project
  const env = { HUDDLE_URL: U, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "twice", HUDDLE_HOME: home };
  const first = await run("stop.ts", {}, env);
  expect(JSON.parse(first.stdout).decision).toBe("block");
  const again = await run("stop.ts", {}, env);
  expect(again.exitCode).toBe(0);
  expect(again.stdout).toBe(""); // the asker may be gone: one reminder is enough
  await op("hooks", "send", "senior", { to: "twice", msg: "and this one?", ask: true });
  const next = await run("stop.ts", {}, env);
  expect(JSON.parse(next.stdout).reason).toContain("and this one?"); // a new ask still counts
  expect(JSON.parse(next.stdout).reason).not.toContain("still there?");
  await op("hooks", "send", "senior", { to: "twice", msg: "an old one", ask: true });
  await Bun.sleep(50);
  const stale = await run("stop.ts", {}, { ...env, HUDDLE_HOME: mkdtempSync(`${tmpdir()}/huddle-stop-home-`), HUDDLE_STOP_MAX_AGE: "0" });
  expect(stale.stdout).toBe(""); // older than the limit: never blocks
}, 60_000);

test("the stop hook never blocks: the guard, a subagent, an empty inbox, or anything broken", async () => {
  const open = { HUDDLE_URL: U, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "me" }; // the ask above is still open
  const cases: Array<[string, unknown, Record<string, string>]> = [
    ["stop_hook_active is set", { stop_hook_active: true }, open],
    ["a subagent answers through its parent", { agent_id: "toolu_1" }, open],
    ["the inbox is empty", {}, { ...open, HUDDLE_AS: "quiet" }],
    ["Huddle is down", {}, { ...open, HUDDLE_URL: DOWN }],
    ["Huddle never answers (deadline 5 s)", {}, { ...open, HUDDLE_URL: MUTE }],
    ["Huddle answers garbage", {}, { ...open, HUDDLE_URL: GARBAGE }],
    ["Huddle answers the wrong shape", {}, { ...open, HUDDLE_URL: WRONG }],
  ];
  for (const [what, input, env] of cases) {
    const r = await run("stop.ts", input, env);
    expect(r.exitCode, what).toBe(0);
    expect(r.ms, what).toBeLessThan(0.7 * ms("Stop"));
    expect(r.stdout, what).toBe(""); // any Stop-hook output is a decision; none of these may decide
  }
}, 60_000);

test("a session without a credential stays outside: one line at session start, silence after", async () => {
  await op("hooks", "join", "senior");
  await op("hooks", "send", "senior", { to: "stranger", msg: "psst", ask: true }).catch(() => {});
  // no HUDDLE_TOKEN and an empty state dir: this session holds nothing for the server at U
  const env = { HUDDLE_URL: U, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "stranger", HUDDLE_TOKEN: "", XDG_STATE_HOME: mkdtempSync(`${tmpdir()}/huddle-nocred-`) };
  const start = await run("session-start.ts", { source: "startup", session_id: "s-out" }, env);
  expect(start.exitCode).toBe(0);
  const ctx = JSON.parse(start.stdout).hookSpecificOutput.additionalContext as string;
  expect(ctx).toContain(`runs at ${U}, but this session holds no credential`);
  expect(ctx).toContain("/huddle:invite");             // a way back in, not a dead end
  expect(JSON.parse(start.stdout).systemMessage).toBeUndefined(); // no dashboard link for a session outside
  for (const [hook, input] of [["listen.ts", { session_id: "s-out", hook_event_name: "PostToolUse" }], ["stop.ts", { session_id: "s-out" }]] as const) {
    const r = await run(hook, input, env);
    expect(r.exitCode, hook).toBe(0);
    expect(r.stdout, hook).toBe("");
    expect(r.stderr, hook).toBe("");
  }
}, 30_000);

test("a joined member sees a dashboard link when a session starts, as a message to the user, never in Claude's context", async () => {
  const inv = await (await fetch(`${U}/api/tokens`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ channel: "hooks" }) })).json() as any;
  const j = await (await fetch(`${U}/api/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inv.token, name: "member" }) })).json() as any;
  const state = mkdtempSync(`${tmpdir()}/huddle-member-`);
  mkdirSync(`${state}/huddle/sessions`, { recursive: true });
  writeFileSync(`${state}/huddle/sessions/s-mem.json`, JSON.stringify({ url: U, channel: "hooks", as: "member", credential: j.credential }));
  const env = { HUDDLE_URL: U, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "member", HUDDLE_TOKEN: "", XDG_STATE_HOME: state };
  const quiet = await run("session-start.ts", { source: "resume", session_id: "s-mem" }, env); // a resume or /clear: no new link
  expect(JSON.parse(quiet.stdout).hookSpecificOutput.additionalContext).toContain('as "member"');
  expect(JSON.parse(quiet.stdout).systemMessage).toBeUndefined();
  for (const source of ["startup"]) {
    const r = await run("session-start.ts", { source, session_id: "s-mem" }, env);
    expect(r.exitCode, source).toBe(0);
    const out = JSON.parse(r.stdout), ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx, source).toContain('You are in Huddle channel "hooks" as "member"');
    expect(out.systemMessage, source).toMatch(new RegExp(`Huddle dashboard .*${U}/\\?code=\\S+`));
    expect(out.systemMessage, source).toContain("/huddle:open");
    expect(ctx, source).not.toContain("code=");
    expect(ctx, source).not.toContain(j.credential);
    const code = /\?code=(\S+)/.exec(out.systemMessage)![1];
    expect((await fetch(`${U}/?code=${code}`, { redirect: "manual" })).status, source).toBe(303); // it signs a browser in
  }
}, 30_000);

test("/huddle:open runs huddle open and never asks for the code", async () => {
  const md = readFileSync(`${ROOT}/plugin/commands/open.md`, "utf8");
  expect(md).toMatch(/^---\ndescription: .+\nallowed-tools: Bash\n---\n/);
  expect(md).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/huddle" open');
  expect(readFileSync(`${ROOT}/plugin/commands/join.md`, "utf8")).toContain("/huddle:open");
});

test("the session that starts Huddle holds its root credential and sees, once, the join command and a dashboard link", async () => {
  const port = await freePort(), u = `http://127.0.0.1:${port}`, state = mkdtempSync(`${tmpdir()}/huddle-creator-`);
  const env = { HUDDLE_URL: u, HUDDLE_CHANNEL: "made", HUDDLE_AS: "boss", HUDDLE_AUTOSTART: "1", HUDDLE_TOKEN: "", XDG_STATE_HOME: state };
  const r = await run("session-start.ts", { source: "startup", session_id: "s-boss" }, env);
  const pid = (() => { try { return Number(readFileSync(`${r.world}/huddle.pid`, "utf8")); } catch { return 0; } })();
  try {
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('You are in Huddle channel "made" as "boss"');
    const m = new RegExp(`/huddle:join 127\\.0\\.0\\.1:${port} --token ([a-z0-9]{6}\\.[a-z0-9]{16})`).exec(out.systemMessage);
    expect(m).not.toBeNull();                                   // the owner sees it, to paste elsewhere
    expect(ctx).not.toContain(m![1]);                           // Claude never does
    expect(ctx).not.toContain("--token");
    expect(out.systemMessage).toMatch(new RegExp(`Huddle dashboard .*http://127\\.0\\.0\\.1:${port}/\\?code=`));
    // the session's credential is the root one, kept 0600 in a 0700 dir; the invite is not kept
    const dir = `${state}/huddle/sessions`;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const file = `${dir}/s-boss.json`;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const cred = JSON.parse(readFileSync(file, "utf8"));
    expect(cred).toMatchObject({ url: u, channel: "made", as: "boss", root: true });
    expect(readFileSync(file, "utf8")).not.toContain(m![1].split(".")[1]);
    // the invite lets another session in, under its own name
    const j = await (await fetch(`${u}/api/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: m![1], name: "dev" }) })).json() as any;
    expect(j).toMatchObject({ name: "dev", channel: "made" });
    // a later start of the same session joins quietly: no new invite
    const again = await run("session-start.ts", { source: "resume", session_id: "s-boss" }, env);
    expect(JSON.parse(again.stdout).hookSpecificOutput.additionalContext).not.toContain("/huddle:join");
  } finally { if (pid) try { process.kill(pid, "SIGTERM"); } catch {} }
}, 30_000);

test("the listen hook reports an edit as a repo-relative path (never its contents) and tells the second session, once", async () => {
  await op("hooks", "join", "payments"); await op("hooks", "join", "shop");
  const repo = mkdtempSync(`${tmpdir()}/huddle-edit-repo-`);
  mkdirSync(`${repo}/.git`); mkdirSync(`${repo}/src`);
  const edit = (session: string, extra: Record<string, unknown> = {}) => run("listen.ts",
    { session_id: `s-${session}`, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: `${repo}/src/cart.ts`, content: "TOP-SECRET-CONTENT" }, cwd: repo, ...extra },
    { HUDDLE_URL: U, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: session });
  const first = await edit("payments");
  expect(first.exitCode).toBe(0);
  expect(first.stdout).not.toMatch(/edited src\/cart\.ts/);
  const second = await edit("shop");
  expect(second.exitCode).toBe(0); expect(second.ms).toBeLessThan(ms("PostToolUse"));
  const ctx = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
  expect(ctx).toMatch(/payments edited src\/cart\.ts .* coordinate with it/);
  neverBlocks(second.stdout);
  const again = await edit("shop");
  expect(again.stdout).not.toMatch(/edited src\/cart\.ts/); // once per file per window
  // a subagent's edit counts as its session's, and its warning goes to the subagent
  const sub = await run("listen.ts", { session_id: "s-pay", agent_id: "ag-1", hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: `${repo}/src/cart.ts` }, cwd: repo },
    { HUDDLE_URL: U, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "payments" });
  expect(JSON.parse(sub.stdout).hookSpecificOutput.additionalContext).toMatch(/shop edited src\/cart\.ts/);
  const c = await (await fetch(`${U}/api/c/hooks/conflicts`, { headers: H })).json() as any;
  expect(c.conflicts.find((x: any) => x.path === "src/cart.ts").sessions.map((s: any) => s.name).sort()).toEqual(["payments", "shop"]);
  expect(JSON.stringify(c)).not.toContain("TOP-SECRET");
  // a Huddle that is down: silence, inside the deadline
  const down = await run("listen.ts", { session_id: "s-d", hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: `${repo}/src/cart.ts` }, cwd: repo },
    { HUDDLE_URL: DOWN, HUDDLE_CHANNEL: "hooks", HUDDLE_AS: "shop" });
  expect(down.exitCode).toBe(0); expect(down.stdout).toBe(""); expect(down.ms).toBeLessThan(ms("PostToolUse"));
}, 60_000);
