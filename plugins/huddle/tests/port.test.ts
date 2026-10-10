// No fixed port: each huddle home gets a random five-digit one on its first `huddle up`, saved in
// <home>/huddle.json and reused; an override (HUDDLE_PORT, --port) wins and is saved; a port huddle
// picked that another program now holds moves; a port someone chose (an existing 8808 too) stays.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOW, HIGH, portFree, randomPort } from "../plugin/server/src/port";

const ROOT = `${import.meta.dir}/..`;
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUDDLE_") && k !== "CLAUDE_PROJECT_DIR")) as Record<string, string>;
// a CLI in a throwaway project whose huddle home is home (no HUDDLE_URL: the port comes from home)
const cli = (home: string, env: Record<string, string> = {}) => (...a: string[]) => {
  const r = Bun.spawnSync(["bun", `${ROOT}/plugin/bin/huddle.ts`, ...a], { cwd: home, env: { ...clean(), HUDDLE_TOKEN: process.env.HUDDLE_TOKEN!,
    HUDDLE_HOME: home, CLAUDE_PROJECT_DIR: home, XDG_STATE_HOME: `${home}/state`, HUDDLE_CHANNEL: "p", HUDDLE_AS: "a", ...env } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};
const saved = (home: string) => JSON.parse(readFileSync(`${home}/huddle.json`, "utf8"));
const who = (home: string, env: Record<string, string> = {}) => {
  const r = Bun.spawnSync(["bun", "-e", `import { identity } from "${ROOT}/plugin/bin/identity.ts"; console.log(JSON.stringify(identity()))`],
    { cwd: home, env: { ...clean(), HUDDLE_HOME: home, CLAUDE_PROJECT_DIR: home, XDG_STATE_HOME: mkdtempSync(`${tmpdir()}/huddle-st-`), ...env } });
  return JSON.parse(r.stdout.toString());
};
const inRange = (p: number) => p >= LOW && p <= HIGH && String(p).length === 5;

test("randomPort: a free five-digit port; portFree knows a taken one", async () => {
  for (let i = 0; i < 20; i++) expect(inRange(await randomPort())).toBe(true);
  const s = Bun.serve({ port: await randomPort(), hostname: "127.0.0.1", fetch: () => new Response() });
  try { expect(await portFree(s.port!)).toBe(false); } finally { s.stop(true); }
});

test("the first huddle up picks a random port and saves it; the next start reuses it", async () => {
  const home = mkdtempSync(`${tmpdir()}/huddle-port-`), run = cli(home);
  try {
    expect(run("server")).toMatchObject({ code: 5, out: expect.stringContaining("no port here yet") });
    const first = run("up");
    expect(first.code, first.out).toBe(0);
    const { port, port_auto } = saved(home);
    expect(inRange(port)).toBe(true); expect(port_auto).toBe(true);
    expect(first.out).toContain(`picked port ${port}`);
    expect(first.out).toContain(`started at http://127.0.0.1:${port}`);
    expect(first.out).toMatch(new RegExp(`join: +/huddle:join 127\\.0\\.0\\.1:${port} --token`));
    expect(run("server").out).toContain(`up at http://127.0.0.1:${port}`);
    expect(who(home)).toMatchObject({ url: `http://127.0.0.1:${port}`, source: "saved" });
    expect(run("down").code).toBe(0);
    const again = run("up");
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain(`started at http://127.0.0.1:${port}`); // the same address as before
    expect(saved(home).port).toBe(port);
  } finally { run("down"); }
}, 60_000);

test("a saved port another program took: huddle up moves to a new one and says so; a chosen one is never moved", async () => {
  const home = mkdtempSync(`${tmpdir()}/huddle-taken-`), run = cli(home);
  const other = Bun.serve({ port: await randomPort(), hostname: "127.0.0.1", fetch: () => new Response("not huddle", { status: 404 }) });
  try {
    writeFileSync(`${home}/huddle.json`, JSON.stringify({ port: other.port, port_auto: true }));
    const r = run("up");
    expect(r.code, r.out).toBe(0);
    const moved = saved(home).port;
    expect(moved).not.toBe(other.port); expect(inRange(moved)).toBe(true); expect(saved(home).port_auto).toBe(true);
    expect(r.out).toContain(`port ${other.port} is taken by another program: Huddle moved to port ${moved}`);
    expect(r.out).toContain(`started at http://127.0.0.1:${moved}`);
    run("down");
    // someone's own choice: kept, and up says what to do instead of moving it
    writeFileSync(`${home}/huddle.json`, JSON.stringify({ channel: "p", port: other.port }));
    const no = run("up");
    expect(no.code).toBe(5); expect(no.out).toContain(`port ${other.port} is taken by another program`);
    expect(saved(home)).toEqual({ channel: "p", port: other.port });
  } finally { other.stop(true); run("down"); }
}, 60_000);

test("an override wins and is saved: HUDDLE_PORT, huddle up --port, huddle setup --port", async () => {
  const home = mkdtempSync(`${tmpdir()}/huddle-over-`), run = cli(home);
  try {
    writeFileSync(`${home}/huddle.json`, JSON.stringify({ port: await randomPort(), port_auto: true }));
    const p1 = await randomPort();
    const a = cli(home, { HUDDLE_PORT: String(p1) })("up");
    expect(a.code, a.out).toBe(0); expect(a.out).toContain(`started at http://127.0.0.1:${p1}`);
    expect(saved(home)).toEqual({ port: p1 });                       // saved, as a choice (no port_auto)
    expect(who(home)).toMatchObject({ url: `http://127.0.0.1:${p1}`, source: "saved" });
    run("down");
    const p2 = await randomPort();
    const b = run("up", "--port", String(p2));
    expect(b.code, b.out).toBe(0); expect(b.out).toContain(`started at http://127.0.0.1:${p2}`);
    expect(saved(home)).toEqual({ port: p2 });
    run("down");
    const p3 = await randomPort();
    const c = run("setup", "--port", String(p3));
    expect(c.code, c.out).toBe(0);
    expect(saved(home).port).toBe(p3); expect(saved(home).port_auto).toBeUndefined();
    expect(run("setup", "show").out).toContain(`port:     ${p3}`);
    expect(run("setup", "--port", "x").code).toBe(2);
    // HUDDLE_URL still wins over every saved port
    expect(who(home, { HUDDLE_URL: "http://127.0.0.1:12345" })).toMatchObject({ url: "http://127.0.0.1:12345", source: "env" });
  } finally { run("down"); }
}, 60_000);

test("migration: an explicit 8808 stays; a running server with no saved port is found and its port saved", async () => {
  const kept = mkdtempSync(`${tmpdir()}/huddle-8808-`);
  writeFileSync(`${kept}/huddle.json`, JSON.stringify({ channel: "c", as: "x", port: 8808 }));
  expect(who(kept)).toMatchObject({ url: "http://127.0.0.1:8808", source: "saved" });
  expect(saved(kept)).toEqual({ channel: "c", as: "x", port: 8808 });  // never rewritten
  // a running server with huddle.pid but no port in huddle.json
  const home = mkdtempSync(`${tmpdir()}/huddle-old-`), port = await randomPort();
  writeFileSync(`${home}/huddle.json`, JSON.stringify({ channel: "c", as: "x", domain: "huddle.test", web_port: 8443 })); // unknown keys: ignored
  const srv = Bun.spawn(["bun", `${ROOT}/plugin/server/server.ts`], { env: { ...clean(), PORT: String(port), HUDDLE_TOKEN: process.env.HUDDLE_TOKEN!, HUDDLE_DATA: `${home}/data` }, stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 300; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(100); }
    writeFileSync(`${home}/huddle.pid`, String(srv.pid));
    expect(who(home)).toMatchObject({ url: `http://127.0.0.1:${port}`, source: "running" });
    expect(saved(home)).toMatchObject({ channel: "c", as: "x", port });   // saved once, as the user's
    expect(saved(home).port_auto).toBeUndefined();
    expect(who(home)).toMatchObject({ url: `http://127.0.0.1:${port}`, source: "saved" });
    expect(cli(home)("up").out).toContain(`up at http://127.0.0.1:${port}`);
  } finally { srv.kill(); await srv.exited; }
}, 60_000);

test("a server started by hand with no PORT picks a random five-digit one", async () => {
  const srv = Bun.spawn(["bun", `${ROOT}/plugin/server/server.ts`], { env: { ...clean(), HUDDLE_TOKEN: process.env.HUDDLE_TOKEN!, HUDDLE_DATA: mkdtempSync(`${tmpdir()}/huddle-hand-`) }, stdout: "pipe", stderr: "ignore" });
  try {
    const reader = srv.stdout.getReader(); let text = "";
    while (!/on http:\/\/127\.0\.0\.1:\d+/.test(text)) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    const port = Number(/on http:\/\/127\.0\.0\.1:(\d+)/.exec(text)![1]);
    expect(inRange(port)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  } finally { srv.kill(); await srv.exited; }
}, 30_000);

test("no fixed port is left in the code, the docs or the tests (only this file's migration case names 8808)", () => {
  const hits: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (n === "node_modules" || n === ".git") continue;
    if (statSync(f).isDirectory()) walk(f);
    else if (f !== import.meta.path && /8808|8809/.test(readFileSync(f, "utf8"))) hits.push(f);
  } };
  walk(ROOT);
  expect(hits).toEqual([]);
});
