// The server outlives the plugin that started it (plugin/server/src/lifecycle.ts): the registry
// tells whether the plugin is still wanted, unreadable files never act, two agreeing checks do —
// and the channels, the user's conversations, survive the server's own exit.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import type { Subprocess } from "bun";
import { presence, watchRemoval, removeRunFiles, writeLeftBehind, leftBehindPath } from "../plugin/server/src/lifecycle";
import { H } from "./env";

const KEY = "huddle@muhmdraouf", ENTRY = [{ scope: "user", installPath: "/x", version: "1" }];
const write = (path: string, body: unknown) => writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
const world = () => {
  const config = mkdtempSync(join(tmpdir(), "huddle-cfg-"));
  mkdirSync(join(config, "plugins"), { recursive: true });
  return { config, env: { HOME: config, CLAUDE_CONFIG_DIR: config } as NodeJS.ProcessEnv };
};
const install = (config: string, plugins: Record<string, unknown> = { [KEY]: ENTRY }) =>
  write(join(config, "plugins", "installed_plugins.json"), { version: 2, plugins });

test("presence: unknown while the registry is missing, half-written, or a foreign shape", () => {
  const w = world();
  expect(presence(w.env, "huddle", [])).toBe("unknown");                    // no file yet
  write(join(w.config, "plugins", "installed_plugins.json"), "{half-written");
  expect(presence(w.env, "huddle", [])).toBe("unknown");                    // a torn write
  install(w.config, { [KEY]: "not a list" });
  expect(presence(w.env, "huddle", [])).toBe("unknown");                    // not the shape Claude Code writes
});

test("presence: uninstalled when no key names the plugin, under any marketplace", () => {
  const w = world();
  install(w.config);
  install(w.config, { "other@market": ENTRY });
  expect(presence(w.env, "huddle", [])).toBe("uninstalled");
  install(w.config, {});
  expect(presence(w.env, "huddle", [])).toBe("uninstalled");                // nothing installed at all
  install(w.config, { "huddle@fork": ENTRY });
  expect(presence(w.env, "huddle", [])).toBe("present");                    // a fork counts
});

test("presence: the user scope disables, a known project re-enables, unreadable settings wait", () => {
  const w = world();
  install(w.config);
  expect(presence(w.env, "huddle", [])).toBe("present");                    // no settings at all
  write(join(w.config, "settings.json"), "{oops");
  expect(presence(w.env, "huddle", [])).toBe("unknown");                    // unreadable settings
  write(join(w.config, "settings.json"), { enabledPlugins: { [KEY]: true } });
  expect(presence(w.env, "huddle", [])).toBe("present");
  write(join(w.config, "settings.json"), { enabledPlugins: { [KEY]: false } });
  expect(presence(w.env, "huddle", [])).toBe("disabled");
  const proj = mkdtempSync(join(tmpdir(), "huddle-proj-"));
  mkdirSync(join(proj, ".claude"), { recursive: true });
  expect(presence(w.env, "huddle", [proj])).toBe("disabled");               // the project says nothing
  write(join(proj, ".claude/settings.json"), { enabledPlugins: { [KEY]: false } });
  expect(presence(w.env, "huddle", [proj])).toBe("disabled");
  write(join(proj, ".claude/settings.local.json"), { enabledPlugins: { [KEY]: true } });
  expect(presence(w.env, "huddle", [proj])).toBe("present");                // the local scope says yes
});

test("watchRemoval: two consecutive agreeing checks act once; present and unknown reset", async () => {
  const w = world();
  install(w.config);
  const gone: string[] = [];
  const watch = watchRemoval({ env: w.env, plugin: "huddle", projects: () => [], ms: 3_600_000, gone: k => { gone.push(k); } });
  await watch.tick();                                                       // present: nothing
  expect(gone).toEqual([]);
  write(join(w.config, "plugins", "installed_plugins.json"), "{torn");
  await watch.tick();                                                       // unknown: nothing, and a reset
  expect(gone).toEqual([]);
  install(w.config, { "other@market": ENTRY });
  await watch.tick();                                                       // uninstalled, first sighting
  expect(gone).toEqual([]);
  write(join(w.config, "plugins", "installed_plugins.json"), "{torn");
  await watch.tick();                                                       // unknown again: reset
  install(w.config, { "other@market": ENTRY });
  await watch.tick();                                                       // first sighting after the reset
  await watch.tick();                                                       // agrees: gone
  expect(gone).toEqual(["uninstalled"]);
  await watch.tick();                                                       // the watch is done
  expect(gone).toEqual(["uninstalled"]);
});

test("watchRemoval: a disable and an uninstall do not add up; two of a kind do", async () => {
  const w = world();
  install(w.config);
  write(join(w.config, "settings.json"), { enabledPlugins: { [KEY]: false } });
  const gone: string[] = [];
  const watch = watchRemoval({ env: w.env, plugin: "huddle", projects: () => [], gone: k => { gone.push(k); } });
  await watch.tick();                                                       // disabled, once
  install(w.config, { "other@market": ENTRY });                             // now uninstalled
  await watch.tick();                                                       // disagrees with the last sighting
  expect(gone).toEqual([]);
  await watch.tick();                                                       // twice the same
  expect(gone).toEqual(["uninstalled"]);
  watch.stop();
});

test("the run files leave; the channels, the settings and the note stay", async () => {
  const home = mkdtempSync(join(tmpdir(), "huddle-left-"));
  write(join(home, "huddle.pid"), "123");
  write(join(home, "huddle.log"), "log");
  write(join(home, "hooks.log"), "x"); write(join(home, "stop-raised.json"), "{}");
  mkdirSync(join(home, "seen")); write(join(home, "seen/s1.json"), "{}");
  write(join(home, "huddle.json"), "{}");
  mkdirSync(join(home, "data", "channels"), { recursive: true });
  write(join(home, "data/channels/shop.db"), "sqlite");
  removeRunFiles(home);
  expect(existsSync(join(home, "huddle.pid"))).toBe(false);
  expect(existsSync(join(home, "huddle.log"))).toBe(false);
  for (const f of ["hooks.log", "stop-raised.json", "seen"]) expect(existsSync(join(home, f)), f).toBe(false);
  expect(existsSync(join(home, "huddle.json"))).toBe(true);
  expect(existsSync(join(home, "data/channels/shop.db"))).toBe(true);
  writeLeftBehind(home, `${home}/data`);
  const note = await Bun.file(leftBehindPath(home)).text();
  expect(note).toContain(`${home}/data/channels`);
  expect(note).toContain("rm -rf");
  expect(note).toContain("huddle.json");
});

// ── the whole story, on a real server ────────────────────────────────────────────────────────
import { startServer } from "./net";
const ROOT = `${import.meta.dir}/..`;
const op = (u: string, ch: string, name: string, as: string, body: unknown = {}) =>
  fetch(`${u}/api/c/${ch}/op/${name}?as=${as}`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) });

// a server under a temp home and a temp Claude config, watching for its plugin every 100 ms
async function watchedServer(flip: (config: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "huddle-gone-"));
  const config = mkdtempSync(join(tmpdir(), "huddle-gone-cfg-"));
  mkdirSync(join(config, "plugins"), { recursive: true });
  install(config);
  const { p: srv, u } = await startServer({ HOST: "127.0.0.1", HUDDLE_HOME: home, HUDDLE_DATA: "",
    CLAUDE_CONFIG_DIR: config, HUDDLE_REMOVAL_WATCH: "1", HUDDLE_REMOVAL_MS: "100" });
  // a conversation worth keeping, and the run files a `huddle up` would have left
  expect((await op(u, "shop", "join", "a")).ok).toBe(true);
  expect((await op(u, "shop", "send", "a", { msg: "are you still there?" })).ok).toBe(true);
  write(join(home, "huddle.pid"), String(srv.pid));
  write(join(home, "huddle.log"), "started\n");
  return { home, config, srv, u, flip: () => flip(config) };
}

test("a watched server stays up while installed, then removes itself when the plugin is uninstalled", async () => {
  const t = await watchedServer(config => install(config, { "other@market": ENTRY }));
  try {
    await Bun.sleep(700);                                    // many checks, all saying present
    expect((await fetch(`${t.u}/health`)).ok).toBe(true);    // still installed: nothing happens
    write(join(t.config, "plugins", "installed_plugins.json"), "{torn");
    await Bun.sleep(400);                                    // many checks, all unknown
    expect((await fetch(`${t.u}/health`)).ok).toBe(true);    // a torn registry is never an uninstall
    install(t.config, { "other@market": ENTRY });            // now it is really gone
    const code = await Promise.race([t.srv.exited, Bun.sleep(15_000).then(() => "timeout")]);
    expect(code).toBe(0);                                     // a clean exit
    await expect(fetch(`${t.u}/health`)).rejects.toThrow();  // not accepting anything
    expect(existsSync(join(t.home, "huddle.pid"))).toBe(false);
    expect(existsSync(join(t.home, "huddle.log"))).toBe(false);
    expect(existsSync(leftBehindPath(t.home))).toBe(true);
    const note = await Bun.file(leftBehindPath(t.home)).text();
    expect(note).toContain(join(t.home, "data", "channels"));
    // the channel database stayed, whole and readable, its WAL folded back into the file
    const db = join(t.home, "data", "channels", "shop.db");
    expect(existsSync(db)).toBe(true);
    const sql = new SQL(`sqlite://${db}`);
    const rows = await sql.unsafe("SELECT msg FROM events WHERE topic = 'msg'");
    await sql.close();
    expect(rows.map(r => (r as any).msg)).toEqual(["are you still there?"]);
    // the WAL is empty or gone — BunFile's size is `size`, not `length`
    expect((await Bun.file(`${db}-wal`).exists()) ? Bun.file(`${db}-wal`).size : 0).toBe(0);
  } finally { try { process.kill(t.srv.pid, "SIGKILL"); } catch {} }
}, 40_000);

test("a disabled plugin stops the server the same way, and the channel databases stay", async () => {
  const t = await watchedServer(config => write(join(config, "settings.json"), { enabledPlugins: { [KEY]: false } }));
  try {
    t.flip();                                                 // the user scope switches the plugin off
    const code = await Promise.race([t.srv.exited, Bun.sleep(15_000).then(() => "timeout")]);
    expect(code).toBe(0);
    await expect(fetch(`${t.u}/health`)).rejects.toThrow();
    expect(existsSync(join(t.home, "data/channels/shop.db"))).toBe(true);
    expect(existsSync(join(t.home, "huddle.pid"))).toBe(false);
    expect(existsSync(leftBehindPath(t.home))).toBe(true);
  } finally { try { process.kill(t.srv.pid, "SIGKILL"); } catch {} }
}, 40_000);
