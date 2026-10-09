// tests/node/fresh-install.mjs — a brand-new user, for real: plugin/ copied alone into a temp HOME's
// plugin cache (what Claude Code installs from the marketplace source), nothing configured, and
// every line the user touches run exactly as Claude Code runs it — hooks.json, .mcp.json and the
// commands' CLI lines — with CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA, CLAUDE_PROJECT_DIR and the
// hook input on stdin, under each runtime alone on PATH (Bun, then Node; one that is missing or
// too old is skipped). The only step the user takes is /huddle:setup; a second session joins with
// the line it printed. `node --test tests/node/fresh-install.mjs` (npm run test:node runs it too).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemPath } from "./system-path.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMPS = [];
after(() => { for (const d of TMPS) rmSync(d, { recursive: true, force: true }); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10_000) => { for (const t = Date.now(); Date.now() - t < ms; await sleep(50)) { const v = await f(); if (v) return v; } return undefined; };

// each runtime the plugin promises, found the way a user's shell would (absent or too old: skipped)
const which = (cmd) => spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim();
const version = (bin) => spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim().replace(/^v/, "").split(".").map(Number);
const atLeast = (v, min) => v[0] > min[0] || (v[0] === min[0] && (v[1] ?? 0) >= min[1]);
const RUNTIMES = [["bun", [1, 3]], ["node", [22, 5]]].map(([name, min]) => {
  const bin = which(name);
  return { name, bin, skip: !bin ? `${name} is not installed` : !atLeast(version(bin), min) ? `${name} is older than ${min.join(".")}` : false };
});

test("the launchers are committed executable (a git install keeps the mode, nothing chmods them)", () => {
  const modes = spawnSync("git", ["ls-files", "-s", "plugin/bin/huddle", "plugin/bin/huddle-mcp"], { cwd: ROOT, encoding: "utf8" }).stdout;
  if (!modes.trim()) return; // not a git checkout
  for (const l of modes.trim().split("\n")) assert.match(l, /^100755 /, l);
});

for (const rt of RUNTIMES) test(`a fresh install works after /huddle:setup alone, on ${rt.name}`, { skip: rt.skip, timeout: 120_000 }, async () => {
  const T = mkdtempSync(join(tmpdir(), `huddle-fresh-${rt.name}-`)); TMPS.push(T);
  const HOME = join(T, "home"), PROJ = join(T, "My Shop_App"), BIN = join(T, "bin");
  const PLUGIN = join(HOME, ".claude/plugins/cache/muhmdraouf/huddle/0.0.1");
  cpSync(join(ROOT, "plugin"), PLUGIN, { recursive: true }); // only the marketplace source, no repo around it
  mkdirSync(PROJ, { recursive: true });
  if (spawnSync("git", ["init", "-q"], { cwd: PROJ }).status !== 0) mkdirSync(join(PROJ, ".git/info"), { recursive: true });
  mkdirSync(BIN); symlinkSync(rt.bin, join(BIN, rt.name)); // this runtime alone, as the user's PATH may have it
  for (const f of ["bin/huddle", "bin/huddle-mcp"]) assert.ok(statSync(join(PLUGIN, f)).mode & 0o111, `${f} is executable in the installed copy`);

  // what Claude Code gives a plugin's hooks, MCP server and Bash tool; nothing of Huddle's own
  const BASE = { HOME, USER: process.env.USER ?? "user", TMPDIR: T, PATH: `${BIN}:${systemPath(join(T, "sys"))}`,
    XDG_CONFIG_HOME: join(HOME, ".config"), XDG_STATE_HOME: join(HOME, ".local/state"), XDG_DATA_HOME: join(HOME, ".local/share"), XDG_CACHE_HOME: join(HOME, ".cache"),
    CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_DATA: join(HOME, ".claude/plugins/data/huddle-muhmdraouf"), CLAUDE_PROJECT_DIR: PROJ,
    HUDDLE_NOTIFY_LOG: join(T, "notify.log") }; // a notification lands in a file, never on this desktop
  const session = (id, pid) => ({ id, pid: String(pid) });
  const A = session("sess-a", 40001), B = session("sess-b", 40002);
  // a command line from the plugin's files, run by sh as Claude Code does
  const sh = (line, s, o = {}) => {
    const proj = s.proj ?? PROJ;
    const r = spawnSync("/bin/sh", ["-c", line], { cwd: proj, encoding: "utf8", timeout: 60_000, input: o.input,
      env: { ...BASE, CLAUDE_PROJECT_DIR: proj, CLAUDE_PID: s.pid, ...(o.bash ? { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: s.id } : {}) } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks/hooks.json"), "utf8")).hooks;
  const hook = (event, s, extra = {}) => {
    const r = sh(hooks[event][0].hooks[0].command, s, { input: JSON.stringify({ session_id: s.id, hook_event_name: event, cwd: s.proj ?? PROJ, ...extra }) });
    assert.equal(r.code, 0, `${event}: ${r.err}`);
    return r.out.trim() ? JSON.parse(r.out) : null;
  };
  // a command's CLI line (commands/*.md name it as "${CLAUDE_PLUGIN_ROOT}/bin/huddle")
  const CLI = '"${CLAUDE_PLUGIN_ROOT}/bin/huddle"';
  for (const c of ["setup", "join", "open", "invite"]) assert.match(readFileSync(join(PLUGIN, `commands/${c}.md`), "utf8"), /"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/huddle"/);
  const huddle = (args, s) => sh(`${CLI} ${args}`, s, { bash: true });

  // the MCP server, as .mcp.json starts it
  const mcpCfg = JSON.parse(readFileSync(join(PLUGIN, ".mcp.json"), "utf8")).mcpServers.huddle;
  const expand = (a) => a.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN);
  const mcp = async (s, calls) => {
    const p = spawn(expand(mcpCfg.command), mcpCfg.args.map(expand), { cwd: s.proj ?? PROJ, env: { ...BASE, CLAUDE_PROJECT_DIR: s.proj ?? PROJ, CLAUDE_PID: s.pid }, stdio: ["pipe", "pipe", "ignore"] });
    const lines = []; let buf = "";
    p.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    calls.forEach((c, i) => send({ jsonrpc: "2.0", id: 3 + i, method: "tools/call", params: { name: c, arguments: {} } }));
    const all = await until(() => lines.filter(l => l.id !== undefined).length >= 2 + calls.length && lines, 30_000);
    p.kill();
    assert.ok(all, `the MCP server answered: ${JSON.stringify(lines)}`);
    return Object.fromEntries(lines.filter(l => l.id !== undefined).map(l => [l.id, l]));
  };
  const pidfile = join(PROJ, ".agents/huddle/huddle.pid");
  try {
    // 1. installed, nothing set up: every hook is silent, the MCP server connects with two tools and says what to do
    for (const ev of Object.keys(hooks)) assert.equal(hook(ev, A, { source: "startup" }), null, `${ev} before setup is silent`);
    const pre = await mcp(A, ["status"]);
    assert.equal(pre[1].result?.serverInfo?.name, "huddle", "initialize answers before setup (Claude Code would mark the server failed)");
    assert.deepEqual(pre[2].result.tools.map(t => t.name), ["status", "join"], "tools/list answers before setup, with two tools");
    assert.match(pre[3].result.content[0].text, /\/huddle:setup/);

    // 2. /huddle:setup: no questions, no files to write; the line for another session reaches the user, not Claude
    const setup = huddle("setup --start", A);
    assert.equal(setup.code, 0, setup.out + setup.err);
    const cfg = JSON.parse(readFileSync(join(PROJ, ".agents/huddle/huddle.json"), "utf8"));
    assert.deepEqual([cfg.channel, cfg.as, cfg.autostart], ["my-shop-app", "my-shop-app", true]);
    assert.ok(Number.isInteger(cfg.port) && cfg.port >= 10000, "a random five-digit port, saved");
    assert.match(setup.out, /^join: .*shows to the user/m);
    assert.doesNotMatch(setup.out + setup.err, /--token|code=/, "inside Claude Code no invite or sign-in code reaches Claude's context");
    assert.match(setup.out, /^UI: +http:\/\/127\.0\.0\.1:\d+ /m);
    assert.match(readFileSync(join(PROJ, ".git/info/exclude"), "utf8"), /^\.agents\/huddle\/$/m);
    const after = hook("PostToolUse", A);                     // right after the command: to the user
    const inv = /\/huddle:join (127\.0\.0\.1:\d+) --token (\S+)/.exec(after?.systemMessage ?? "");
    assert.ok(inv, `the user got the join line: ${JSON.stringify(after)}`);
    assert.match(after.systemMessage, /\?code=/, "and the dashboard link");
    assert.doesNotMatch(JSON.stringify(after.hookSpecificOutput ?? {}), /--token|code=/);
    const join_ = huddle("join", A);
    assert.equal(join_.code, 0, join_.err);
    assert.match(join_.out, /you are my-shop-app/);

    // 3. the creator's next session start: in the channel, a dashboard link for the user only
    const ss = hook("SessionStart", A, { source: "startup" });
    assert.match(ss.hookSpecificOutput.additionalContext, /You are in Huddle channel "my-shop-app" as "my-shop-app"/);
    const link = /(http:\/\/127\.0\.0\.1:\d+)\/\?code=([\w-]+)/.exec(ss.systemMessage ?? "");
    assert.ok(link, `the user gets a sign-in link: ${JSON.stringify(ss)}`);
    assert.doesNotMatch(ss.hookSpecificOutput.additionalContext, /code=|--token/);
    const login = await fetch(`${link[1]}/?code=${link[2]}`, { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    assert.ok(cookie, "the code signs the browser in");
    for (const [path, type] of [["/", "text/html"], ["/static/app.css", "text/css"], ["/static/app.js", "text/javascript"], ["/fonts/ibm-plex-mono-latin-400-normal.woff2", "font/woff2"]]) {
      const r = await fetch(`${link[1]}${path}`, { headers: { cookie } });
      assert.equal(r.status, 200, path); assert.match(r.headers.get("content-type") ?? "", new RegExp(type), path);
    }
    const chans = await (await fetch(`${link[1]}/api/channels`, { headers: { cookie } })).json();
    assert.deepEqual(chans.map(c => c.name), ["my-shop-app"]);
    const mine = await mcp(A, ["status"]);
    assert.match(mine[3].result.content[0].text, /you are my-shop-app/);

    // 4. a new Claude session in the same project is in, with no invite (the project's credential);
    //    another project joins once with the line, and is a session of its own
    const ssB = hook("SessionStart", B, { source: "startup" });
    assert.match(ssB.hookSpecificOutput.additionalContext, /You are in Huddle channel "my-shop-app"/);
    const PROJ2 = join(T, "web-client"); mkdirSync(PROJ2, { recursive: true });
    if (spawnSync("git", ["init", "-q"], { cwd: PROJ2 }).status !== 0) mkdirSync(join(PROJ2, ".git/info"), { recursive: true });
    const C = { ...session("sess-c", 40003), proj: PROJ2 }, C2 = { ...session("sess-c2", 40004), proj: PROJ2 };
    const before = hook("SessionStart", C, { source: "startup" });
    assert.equal(before, null, "a project with nothing set up and no credential stays silent");
    const jc = huddle(`join ${inv[1]} --token ${inv[2]}`, C); // commands/join.md
    assert.equal(jc.code, 0, jc.err);
    assert.match(jc.out, /you are web-client/);
    assert.match(jc.out, /others: my-shop-app/);
    assert.doesNotMatch(jc.out + jc.err, /code=/);
    const mineC = await mcp(C2, ["status"]);                  // a later session of that project, by MCP
    assert.match(mineC[3].result.content[0].text, /you are web-client/);
    assert.equal(huddle('send "hello from the second project"', C).code, 0);
    const heard = hook("PostToolUse", A);
    assert.match(JSON.stringify(heard), /hello from the second project/, "the creator hears the second project");
    const linkC = hook("PostToolUse", C);
    assert.match(linkC?.systemMessage ?? "", /\?code=/, "the joiner's dashboard link reaches the user");
    // /huddle:open: the plain address for Claude, the link through the next hook
    const open = huddle("open", C);
    assert.equal(open.code, 0, open.err);
    assert.doesNotMatch(open.out, /code=/);
    assert.match(hook("PostToolUse", C)?.systemMessage ?? "", /\?code=/);
    // /huddle:invite: the next line, to the user only
    const more = huddle("token create --print-join-command", A);
    assert.equal(more.code, 0, more.err);
    assert.doesNotMatch(more.out + more.err, /--token/);
    assert.match(hook("PostToolUse", A)?.systemMessage ?? "", /\/huddle:join 127\.0\.0\.1:\d+ --token /);
    assert.equal(hook("Stop", C), null);
    assert.equal(hook("Stop", A), null);

    // 5. after a reboot (the server gone), the next session start brings it back by itself, and
    //    every member is still in: no new invite needed anywhere
    const pid = Number(readFileSync(pidfile, "utf8"));
    process.kill(pid, "SIGKILL");
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    const back = hook("SessionStart", A, { source: "startup" });
    assert.match(back.hookSpecificOutput.additionalContext, /You are in Huddle channel "my-shop-app"/);
    assert.doesNotMatch(back.systemMessage ?? "", /--token/, "no fresh join line: members are remembered");
    const backC = hook("SessionStart", { ...session("sess-c3", 40005), proj: PROJ2 }, { source: "startup" });
    assert.match(backC.hookSpecificOutput.additionalContext, /You are in Huddle channel "my-shop-app" as "web-client"/);
  } finally {
    huddle("down", A);
    try { process.kill(Number(readFileSync(pidfile, "utf8")), "SIGTERM"); } catch {}
  }
});
