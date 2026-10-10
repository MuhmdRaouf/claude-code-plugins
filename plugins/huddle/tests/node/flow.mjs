// tests/node/flow.mjs — the user's flow, end to end, for real: headless `claude -p` runs of the
// plugin's slash commands (/huddle:setup, /huddle:invite, /huddle:join) in two temp git projects,
// then the dashboard in a real browser (playwright-core over the machine's cached headless
// Chromium). What the user could not get to work — setup, invite, join, open — is asserted at
// every step: the server comes up, the command's output carries the join line and the sign-in
// link, the second project joins and is seen, and the signed-in app renders live, styled and
// without one failed request. Whatever this machine lacks (the claude binary, playwright-core, a
// cached Chromium) skips its leg, so `npm run test:node` stays green where they are absent.
// Never the real home: XDG_STATE_HOME, the projects and the screenshots are temp dirs, the
// session marks of this Claude process are stripped from the child, and the server the commands
// started is stopped and its port checked free at the end. `node --test tests/node/flow.mjs`
// (npm run test:node runs it too). The model is haiku for speed; HUDDLE_FLOW_MODEL names another
// (this repo's router serves glm-5.3-flash, the fallback when the Anthropic account is capped).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN = `${ROOT}/plugin`;
const CLAUDE = spawnSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
// playwright-core is a devDependency; the browser leg skips when it (or a cached Chromium) is missing
const PW = await import("playwright-core").catch(() => null);
const cache = (h) => (process.platform === "darwin" ? `${h}/Library/Caches/ms-playwright` : `${h}/.cache/ms-playwright`);
const CHROME = (() => {
  for (const h of [process.env.HOME ?? "", process.env.XDG_CACHE_HOME ?? ""]) {
    const dir = cache(h);
    if (!existsSync(dir)) continue;
    for (const v of readdirSync(dir).filter(d => /^chromium_headless_shell-/.test(d)).sort().reverse()) {
      for (const arch of ["mac-arm64", "mac", "linux64", "win64"]) {
        const bin = join(dir, v, `chrome-headless-shell-${arch}`, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
        if (existsSync(bin)) return bin;
      }
    }
  }
  return null;
})();

// a clean environment: nothing of this Claude session or of the machine's Huddle leaks in (the
// claude child keeps the routing and auth the user's own environment carries: ANTHROPIC_*, and a
// CLAUDE_CONFIG_DIR when one is set)
const STRIP = [/^HUDDLE_/, /^RADAR_/, /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)$/,
  /^CLAUDE_PLUGIN_/, /^CLAUDE_PROJECT_DIR$/, /^CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|EXECPATH|VERSION|CHILD|SESSION|MESSAGING)/];
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.some(r => r.test(k))));
const TMPS = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), `huddle-flow-${p}-`)); TMPS.push(d); return d; };
const STATE = tmp("state"), RADAR = `${tmp("radar")}/radar`, NOTIFY = `${tmp("notify")}/notify.log`;
// SHOTS survives a failed run (its path prints for the human), a pass deletes it
const SHOTS = mkdtempSync(join(tmpdir(), "huddle-flow-shots-"));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10_000) => { for (const t = Date.now(); Date.now() - t < ms; await sleep(50)) { const v = await f(); if (v) return v; } return undefined; };
// free now: a bind that succeeds (and closes at once) proves nothing listens there
const portFree = (p) => new Promise(r => { const s = createServer(); s.once("error", () => r(false)); s.listen({ port: p, host: "127.0.0.1", exclusive: true }, () => s.close(() => r(true))); });

const PROJ = { a: join(tmp("proj"), "alpha-app"), b: join(tmp("proj"), "beta-app") };
const CE = (proj) => ({ ...CLEAN, XDG_STATE_HOME: STATE, RADAR_HOME: RADAR, HUDDLE_NOTIFY_LOG: NOTIFY, CLAUDE_PROJECT_DIR: proj });
// the CLI the commands run, driven by the test itself (the same env a command's Bash gets)
const huddle = (args, proj) => {
  const r = spawnSync(`${PLUGIN}/bin/huddle`, args, { cwd: proj, env: CE(proj), encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const gitInit = (dir) => { const r = spawnSync("git", ["init", "-q"], { cwd: dir }); if (r.status !== 0) mkdirSync(join(dir, ".git/info"), { recursive: true }); };

// one `claude -p` run of a slash command: its stream-json transcript flattened to the text Claude
// saw and wrote (assistant text plus every tool result, where the command's CLI output lands
// verbatim), the result event, and the exit
let MODEL = process.env.HUDDLE_FLOW_MODEL || "haiku";
const FALLBACK = "glm-5.3-flash"; // what this repo's zai router serves when the Anthropic account is capped
const CAPPED = /\b(weekly |usage |rate |spending )?limit\b|quota|balance|billing|credit/i;
const claude = async (prompt, proj, ms = 6 * 60_000, expect = null) => {
  const run = (model) => new Promise((resolve) => {
    const p = spawn(CLAUDE, ["-p", prompt, "--plugin-dir", PLUGIN, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", model],
      { cwd: proj, env: CE(proj), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGTERM"); setTimeout(() => p.kill("SIGKILL"), 5_000).unref(); }, ms);
    p.stdout.on("data", c => out += c);
    p.stderr.on("data", c => err += c);
    p.once("close", (code, signal) => {
      clearTimeout(timer);
      writeFileSync(`${SHOTS}/${prompt.slice(1).split(" ")[0].replace(/[^a-z-]/g, "")}.jsonl`, out); // the whole transcript, kept when the run fails
      let text = "", result = null;
      for (const line of out.split("\n")) {
        let j; try { j = JSON.parse(line); } catch { continue; }
        const cs = j.message?.content;
        if (j.type === "assistant" && Array.isArray(cs)) for (const c of cs) if (c.type === "text") text += `${c.text}\n`;
        if (j.type === "user" && Array.isArray(cs)) for (const c of cs) if (c.type === "tool_result")
          text += `${typeof c.content === "string" ? c.content : (c.content ?? []).map(x => x.text ?? "").join("\n")}\n`;
        if (j.type === "result") result = j;
      }
      resolve({ code, signal, err, text, result, model });
    });
  });
  const r = await run(MODEL);
  // an account-level cap (the model never ran) is this machine's, not the flow's: once, on another model
  if ((r.code !== 0 || r.result?.is_error) && MODEL !== FALLBACK && CAPPED.test(`${r.result?.result ?? ""}${r.err}`)) {
    MODEL = FALLBACK;
    return claude(prompt, proj, ms, expect);
  }
  // a model that answers without running the command (its "output" invents what the CLI would print)
  // is a headless-LLM hazard, not a product failure: the command is idempotent, so run it once more
  if (expect && r.code === 0 && r.result?.is_error === false && !expect(r.text)) return claude(prompt, proj, ms, null);
  return r;
};
const ok = (r, what) => {
  assert.equal(r.code, 0, `${what}: claude exited ${r.code}${r.signal ? ` (${r.signal})` : ""}: ${r.err.slice(0, 400)}`);
  assert.equal(r.result?.is_error, false, `${what}: ${r.result?.result ?? "no result event"}`);
};
// the join line and the dashboard link a setup, invite or join prints (here or through Claude)
const joinOf = (text) => /\/huddle:join (127\.0\.0\.1:\d+) --token ([a-z0-9]{6}\.[A-Za-z0-9]+)/.exec(text);
const dashOf = (text) => /dashboard:\s*(https?:\/\/127\.0\.0\.1:\d+\/\?code=\S+)/.exec(text);

for (const d of Object.values(PROJ)) { mkdirSync(d, { recursive: true }); gitInit(d); }

let PORT = 0, JOIN = null, DASH = null, SETUP_TEXT = "", MEMBER = "";

test("/huddle:setup starts the server and prints the join line and the dashboard link", { skip: !CLAUDE && "the claude binary is not installed", timeout: 12 * 60_000 }, async () => {
  const r = await claude("/huddle:setup", PROJ.a, 6 * 60_000, (t) => joinOf(t) && dashOf(t));
  SETUP_TEXT = r.text;
  ok(r, "setup");
  // the settings file, its channel and session named after the folder
  const cfg = JSON.parse(readFileSync(join(PROJ.a, ".agents/huddle/huddle.json"), "utf8"));
  assert.equal(cfg.channel, "alpha-app");
  assert.equal(cfg.as, "alpha-app");
  assert.equal(cfg.autostart, true);
  assert.ok(Number.isInteger(cfg.port) && cfg.port >= 10000, `a five-digit port saved: ${cfg.port}`);
  // the two lines the command must show the user
  JOIN = joinOf(SETUP_TEXT);
  assert.ok(JOIN, `a join: line in the setup output: ${SETUP_TEXT.slice(-1200)}`);
  DASH = dashOf(SETUP_TEXT);
  assert.ok(DASH, `a dashboard: link in the setup output: ${SETUP_TEXT.slice(-1200)}`);
  // the server answers, and the session that set it up is in
  PORT = Number(JOIN[1].split(":")[1]);
  assert.equal(PORT, cfg.port, "the join line names the saved port");
  assert.ok(await until(async () => (await fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.ok).catch(() => false))), "the server answers /health");
  const st = huddle(["status"], PROJ.a);
  assert.equal(st.code, 0, st.out + st.err);
  assert.match(st.out, /channel alpha-app · you are alpha-app/);
});

test("/huddle:invite prints a fresh join line", { skip: !CLAUDE && "the claude binary is not installed", timeout: 12 * 60_000 }, async (t) => {
  if (!JOIN) return t.skip("the setup run produced no join line");
  const r = await claude("/huddle:invite", PROJ.a, 6 * 60_000, joinOf);
  ok(r, "invite");
  const inv = joinOf(r.text);
  assert.ok(inv, `a join: line in the invite output: ${r.text.slice(-1200)}`);
  assert.notEqual(inv[2], JOIN[2], "a fresh token, not the setup's");
});

test("/huddle:join brings project B in, and project A sees it", { skip: !CLAUDE && "the claude binary is not installed", timeout: 12 * 60_000 }, async (t) => {
  if (!JOIN) return t.skip("the setup run produced no join line");
  const r = await claude(`/huddle:join ${JOIN[1]} --token ${JOIN[2]}`, PROJ.b, 6 * 60_000, dashOf);
  ok(r, "join");
  assert.ok(dashOf(r.text), `the join prints the dashboard link itself: ${r.text.slice(-1200)}`);
  const me = huddle(["whoami"], PROJ.b);
  assert.equal(me.code, 0, me.out + me.err);
  const id = JSON.parse(me.out);
  assert.equal(id.channel, "alpha-app", "project B is in project A's channel");
  MEMBER = id.as;
  const stB = huddle(["status"], PROJ.b);
  assert.equal(stB.code, 0, stB.out + stB.err);
  assert.match(stB.out, new RegExp(`channel alpha-app · you are ${MEMBER}`));
  // membership, not presence: whether B's session has entered the channel yet is the model's call,
  // the server's member list is not — A's root credential reads it
  const members = huddle(["members"], PROJ.a);
  assert.equal(members.code, 0, members.out + members.err);
  assert.match(members.out, new RegExp(`^${MEMBER}\\b`, "m"), `project A sees the second member: ${members.out}`);
});

test("the dashboard: huddle open in project B signs a real browser in, live and styled", { skip: (!CLAUDE || !PW || !CHROME) && (!CLAUDE ? "the claude binary is not installed" : !PW ? "playwright-core is not installed" : "no cached headless Chromium"), timeout: 3 * 60_000 }, async (t) => {
  if (!MEMBER) return t.skip("no member joined, so there is no dashboard to open");
  const open = huddle(["open"], PROJ.b);
  assert.equal(open.code, 0, open.out + open.err);
  const link = dashOf(open.out);
  assert.ok(link, `huddle open printed a sign-in link: ${open.out}`);
  const errors = [], failed = [], bad = [];
  const isStream = (u) => /\/live|\/events|\/stream|\/sse/.test(u);
  const browser = await PW.chromium.launch({ executablePath: CHROME });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
    page.on("console", m => { if (m.type() === "error") errors.push(`${m.text()} (${m.location()?.url ?? ""})`); });
    page.on("pageerror", e => errors.push(String(e)));
    page.on("response", r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
    page.on("requestfailed", r => { if (!isStream(r.url())) failed.push(`${r.failure()?.errorText ?? "failed"} ${r.url()}`); });
    await page.goto(link[1], { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(hash => { location.hash = hash; }, "#/c/alpha-app/overview");
    // the top bar's Live pill turns Live when the SSE stream is on
    await page.waitForFunction(() => document.querySelector("#ldot")?.getAttribute("aria-label") === "Live updates: on", null, { timeout: 15_000 });
    for (const dest of ["overview", "team", "work", "inbox"]) {
      await page.evaluate(hash => { location.hash = hash; }, `#/c/alpha-app/${dest}`);
      await sleep(1_200); // the page's own fetches
      const style = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, theme: document.documentElement.dataset.theme }));
      assert.notEqual(style.bg, "rgba(0, 0, 0, 0)", `${dest} is unstyled (body background is the default)`);
      assert.ok(["mocha", "latte"].includes(style.theme), `${dest} has no daisyUI theme (data-theme=${style.theme})`);
      await page.screenshot({ path: `${SHOTS}/${dest}.png`, fullPage: true });
    }
    assert.deepEqual(errors, [], "console errors");
    assert.deepEqual(bad, [], "responses with status >= 400");
    assert.deepEqual(failed, [], "failed requests (the aborted /live stream on navigation excepted)");
  } finally {
    await browser.close();
  }
  assert.equal(readdirSync(SHOTS).filter(f => f.endsWith(".png")).length, 4, "one screenshot per page");
  rmSync(SHOTS, { recursive: true, force: true }); // a pass leaves no PNGs and no transcripts behind
});

// a huddle server still answering under this pid (a pid the OS handed to something else must not fail the run)
const serverAlive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch { return false; }
  return /server\.js|server\.ts/.test(spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "");
};
const noted = () => { try { return Object.values(JSON.parse(readFileSync(join(STATE, "huddle/servers.json"), "utf8"))); } catch { return []; } };

test("nothing is left running: the server the commands started is stopped and its port free", async (t) => {
  if (!PORT) return t.skip("no server was started");
  const pid = Number(readFileSync(join(PROJ.a, ".agents/huddle/huddle.pid"), "utf8").trim()); // before down: a successful down removes it
  const down = huddle(["down"], PROJ.a);
  assert.equal(down.code, 0, down.out + down.err);
  assert.match(down.out, /Huddle stopped|not running/);
  assert.ok(await until(() => portFree(PORT)), `port ${PORT} is still listening`);
  assert.equal(serverAlive(pid), false, `the recorded pid ${pid} is gone`);
  // every server the commands started (the registry each `huddle up` notes) is stopped too
  for (const e of noted()) assert.equal(serverAlive(e.pid), false, `a server the commands started (pid ${e.pid}, ${e.url}) still runs`);
});

after(async () => {
  const pids = [...noted().map(e => e.pid)];
  for (const p of Object.values(PROJ)) { // even on failure: no server, no pid, no temp dir left
    try { spawnSync(`${PLUGIN}/bin/huddle`, ["down"], { cwd: p, env: CE(p), timeout: 30_000 }); } catch {}
    try { pids.push(Number(readFileSync(join(p, ".agents/huddle/huddle.pid"), "utf8").trim())); } catch {}
  }
  for (const pid of pids) if (Number.isInteger(pid) && pid > 0 && serverAlive(pid)) try { process.kill(pid, "SIGTERM"); } catch {}
  if (pids.length) await until(() => pids.every(pid => !serverAlive(pid)), 10_000);
  for (const pid of pids) if (Number.isInteger(pid) && pid > 0 && serverAlive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
  // the process table is the truth: any huddle server still working out of this run's temp dirs stops
  for (const row of (spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" }).stdout ?? "").split("\n")) {
    if (!/dist[/]server\.js|server\.ts/.test(row)) continue;
    const pid = Number(row.trim().split(/\s+/)[0]);
    const where = /^n(.+)$/m.exec(spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).stdout ?? "");
    if (where && TMPS.some(d => where[1].startsWith(d))) try { process.kill(pid, "SIGKILL"); } catch {}
  }
  if (PORT) await until(() => portFree(PORT), 10_000);
  for (const d of TMPS) rmSync(d, { recursive: true, force: true });
});
