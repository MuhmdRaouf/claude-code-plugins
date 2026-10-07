import { describe, expect, it } from "vitest";
import { type CliDeps, type FetchResult, parseArgs, parseSince, runCli } from "../src/cli/run.ts";
import { readServerInfo, writeServerInfo } from "../src/server/app.ts";
import { fileExists, savePort, serverInfoPath, wantsAutostart } from "../src/shared/paths.ts";
import { VERSION } from "../src/shared/version.ts";
import { makeEnv } from "./helpers.ts";

const USAGE = "usage: observatory start|stop|status|url|open [--port N] [--since 24h]";
const DAY = 86_400_000;

type Overrides = {
  responses?: (url: string) => FetchResult;
  alive?: (pid: number) => boolean;
  onSpawn?: () => void;
  now?: () => number;
};

/** A CliDeps with every side effect recorded, a fresh temp state dir, and injectable answers. */
function makeDeps(over: Overrides = {}) {
  const { env } = makeEnv();
  const out: string[] = [];
  const err: string[] = [];
  const spawned: string[][] = [];
  const signalled: number[] = [];
  const opened: string[] = [];
  const deps: CliDeps = {
    env,
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
    fetchJson: (url) => Promise.resolve(over.responses?.(url) ?? { ok: false, body: null }),
    spawnDetached: (args) => {
      spawned.push(args);
      over.onSpawn?.();
      return 999;
    },
    signal: (pid) => {
      signalled.push(pid);
      return true;
    },
    isAlive: over.alive ?? (() => false),
    openBrowser: (url) => {
      opened.push(url);
    },
    now: over.now ?? (() => 0),
    sinceMs: DAY,
  };
  return { deps, out, err, spawned, signalled, opened, env };
}

const INFO = { pid: 4242, port: 8787, url: "http://127.0.0.1:8787", startedAt: 1 };

describe("parseSince", () => {
  it("takes Ns/Nm/Nh/Nd case-insensitively, a bare number as hours", () => {
    expect(parseSince("30m")).toBe(1_800_000);
    expect(parseSince("24h")).toBe(86_400_000);
    expect(parseSince("7d")).toBe(604_800_000);
    expect(parseSince("45s")).toBe(45_000);
    expect(parseSince("5")).toBe(18_000_000);
    expect(parseSince("2H")).toBe(7_200_000);
    expect(parseSince("2 hrs")).toBe(7_200_000);
    expect(parseSince(" 10m ")).toBe(600_000);
  });

  it("rejects the unusable", () => {
    for (const raw of [undefined, "", "m", "0h", "-5m", "1.5h", "forever"]) {
      expect(parseSince(raw)).toBeNull();
    }
  });
});

describe("parseArgs", () => {
  it("reads the command and every flag", () => {
    expect(parseArgs(["start"], DAY)).toEqual({
      command: "start",
      sinceMs: DAY,
      foreground: false,
      bad: null,
    });
    expect(parseArgs(["start", "--port", "8080"], DAY)).toMatchObject({ port: 8080, bad: null });
    expect(parseArgs(["start", "--port", "1024"], DAY)).toMatchObject({ port: 1024 }); // the low edge
    expect(parseArgs(["start", "--foreground"], DAY)).toMatchObject({ foreground: true });
    expect(parseArgs(["start", "--since", "30m"], DAY)).toMatchObject({ sinceMs: 1_800_000 });
    expect(parseArgs(["stop", "--since", "2"], DAY)).toMatchObject({ command: "stop", sinceMs: 7_200_000 });
    expect(parseArgs([], DAY)).toMatchObject({ command: "" });
  });

  it("stops at the first bad flag with the exact complaint", () => {
    expect(parseArgs(["start", "--port"], DAY).bad).toBe(
      "--port needs a number in 1024..65535, got: nothing",
    );
    expect(parseArgs(["start", "--port", "80"], DAY).bad).toBe(
      "--port needs a number in 1024..65535, got: 80",
    );
    expect(parseArgs(["start", "--port", "70000"], DAY).bad).toBe(
      "--port needs a number in 1024..65535, got: 70000",
    );
    expect(parseArgs(["start", "--port", "abc"], DAY).bad).toBe(
      "--port needs a number in 1024..65535, got: abc",
    );
    expect(parseArgs(["start", "--since"], DAY).bad).toBe(
      "--since needs a duration like 30m, 24h or 7d, got: nothing",
    );
    expect(parseArgs(["start", "--since", "forever"], DAY).bad).toBe(
      "--since needs a duration like 30m, 24h or 7d, got: forever",
    );
    expect(parseArgs(["start", "--wat"], DAY).bad).toBe("unknown argument: --wat");
  });
});

describe("runCli dispatch", () => {
  it("prints help for help, --help and -h", async () => {
    for (const command of ["help", "--help", "-h"]) {
      const { deps, out } = makeDeps();
      expect(await runCli([command], deps)).toBe(0);
      expect(out).toEqual([
        USAGE,
        "start runs the dashboard server on 127.0.0.1 on a random port unless --port is given",
      ]);
    }
  });

  it("rejects unknown commands and bad flags with usage on stderr", async () => {
    const unknown = makeDeps();
    expect(await runCli(["frob"], unknown.deps)).toBe(1);
    expect(unknown.err).toEqual([`observatory: unknown command: frob`, USAGE]);

    const empty = makeDeps();
    expect(await runCli([], empty.deps)).toBe(1);
    expect(empty.err[0]).toBe("observatory: unknown command: (none)");

    const badFlag = makeDeps();
    expect(await runCli(["start", "--wat"], badFlag.deps)).toBe(1);
    expect(badFlag.err[0]).toBe("observatory: unknown argument: --wat");
  });
});

describe("start", () => {
  it("says a running server cannot take --since or a new --port until it stops", async () => {
    const { deps, out, spawned } = makeDeps({
      alive: (pid) => pid === 4242,
      responses: () => ({ ok: true, body: { ok: true } }),
    });
    writeServerInfo(deps.env, INFO);
    expect(await runCli(["start", "--since", "7d", "--port", "9100"], deps)).toBe(0);
    expect(out).toEqual([
      "observatory: http://127.0.0.1:8787",
      "observatory: already running; --since 7d and --port 9100 applies after /observatory:stop",
    ]);
    expect(spawned).toEqual([]);
  });

  it("says so when the saved port was taken and the server moved", async () => {
    let childUp = false;
    const { deps, out } = makeDeps({
      responses: () => (childUp ? { ok: true, body: { ok: true } } : { ok: false, body: null }),
      onSpawn: () => {
        childUp = true;
        writeServerInfo(deps.env, { pid: 555, port: 9003, url: "http://127.0.0.1:9003", startedAt: 3 });
      },
    });
    savePort(deps.env, 9001);
    expect(await runCli(["start"], deps)).toBe(0);
    expect(out).toEqual([
      "observatory: http://127.0.0.1:9003",
      "observatory: port 9001 was taken; moved to 9003",
    ]);
  });

  it("reuses a recorded healthy server without spawning", async () => {
    const { deps, out, spawned } = makeDeps({
      alive: (pid) => pid === 4242,
      responses: () => ({ ok: true, body: { ok: true } }),
    });
    writeServerInfo(deps.env, INFO);
    expect(await runCli(["start"], deps)).toBe(0);
    expect(out).toEqual(["observatory: http://127.0.0.1:8787"]);
    expect(spawned).toEqual([]);
  });

  it("spawns a replacement when the recorded pid answers no more, and prints the new url", async () => {
    let childUp = false;
    const { deps, out, spawned } = makeDeps({
      alive: (pid) => pid === 4242,
      responses: (url) =>
        childUp && url === "http://127.0.0.1:9001/api/health"
          ? { ok: true, body: { ok: true } }
          : { ok: false, body: null },
      onSpawn: () => {
        childUp = true; // the child binds its own port and writes server.json itself
        writeServerInfo(deps.env, { pid: 555, port: 9001, url: "http://127.0.0.1:9001", startedAt: 2 });
      },
    });
    writeServerInfo(deps.env, INFO);
    expect(await runCli(["start"], deps)).toBe(0);
    expect(spawned).toEqual([["start", "--foreground", "--since", "1d"]]);
    expect(out).toEqual(["observatory: http://127.0.0.1:9001"]);
    expect(readServerInfo(deps.env)?.port).toBe(9001); // the stale record gave way
  });

  it("starts fresh when the recorded pid is dead, polling until the child is healthy", async () => {
    let childUp = false;
    const { deps, out } = makeDeps({
      responses: () => (childUp ? { ok: true, body: { ok: true } } : { ok: false, body: null }),
      onSpawn: () => {
        childUp = true;
        writeServerInfo(deps.env, { pid: 555, port: 9002, url: "http://127.0.0.1:9002", startedAt: 3 });
      },
    });
    writeServerInfo(deps.env, INFO); // isAlive is false everywhere here
    expect(await runCli(["start"], deps)).toBe(0);
    expect(out).toEqual(["observatory: http://127.0.0.1:9002"]);
  });

  it("gives up after the timeout, passing the window and pinned port to the child", async () => {
    let ticks = 0;
    const { deps, err, spawned } = makeDeps({
      now: () => {
        ticks += 1;
        return ticks === 1 ? 0 : 16_000; // deadline set at 0; the next look is past it, so no real sleep
      },
    });
    expect(await runCli(["start", "--port", "8123"], deps)).toBe(1);
    expect(err).toEqual(["observatory: server did not become healthy within 15s"]);
    expect(spawned).toEqual([["start", "--foreground", "--since", "1d", "--port", "8123"]]);
  });
});

describe("stop", () => {
  it("is a no-op when nothing is recorded", async () => {
    const { deps, out, signalled } = makeDeps();
    expect(await runCli(["stop"], deps)).toBe(0);
    expect(out).toEqual(["observatory: not running"]);
    expect(signalled).toEqual([]);
  });

  it("signals a live server and forgets it", async () => {
    const { deps, out, signalled } = makeDeps({ alive: (pid) => pid === 4242 });
    writeServerInfo(deps.env, INFO);
    expect(await runCli(["stop"], deps)).toBe(0);
    expect(signalled).toEqual([4242]);
    expect(fileExists(serverInfoPath(deps.env))).toBe(false);
    expect(out).toEqual(["observatory: stopped"]);
  });

  it("still removes the record when the pid is already gone", async () => {
    const { deps, out, signalled } = makeDeps();
    writeServerInfo(deps.env, INFO);
    expect(await runCli(["stop"], deps)).toBe(0);
    expect(signalled).toEqual([]); // nothing to signal
    expect(fileExists(serverInfoPath(deps.env))).toBe(false);
    expect(out).toEqual(["observatory: stopped"]);
  });
});

describe("status", () => {
  it("exits 3 with nothing recorded or when health fails", async () => {
    const down = makeDeps();
    expect(await runCli(["status"], down.deps)).toBe(3);
    expect(down.out).toEqual([
      "observatory: not running — /observatory:start (or /observatory:open) starts it",
    ]);

    const unhealthy = makeDeps({ alive: (pid) => pid === 4242 });
    writeServerInfo(unhealthy.deps.env, INFO);
    expect(await runCli(["status"], unhealthy.deps)).toBe(3);
    expect(unhealthy.out).toEqual([
      "observatory: not running — /observatory:start (or /observatory:open) starts it",
    ]);
  });

  it("reports uptime and sessions from the health body", async () => {
    const { deps, out } = makeDeps({
      alive: (pid) => pid === 4242,
      responses: () => ({ ok: true, body: { sessions: 2, uptimeMs: 65_000 } }),
      now: () => 70_000,
    });
    writeServerInfo(deps.env, INFO);
    expect(await runCli(["status"], deps)).toBe(0);
    expect(out).toEqual(["observatory: http://127.0.0.1:8787", `  up 1m5s, 2 sessions tracked, v${VERSION}`]);
  });

  it("falls back to the recorded startedAt when the body is bare", async () => {
    const { deps, out } = makeDeps({
      alive: (pid) => pid === 4242,
      responses: () => ({ ok: true, body: { ok: true } }),
      now: () => 74_000,
    });
    writeServerInfo(deps.env, { ...INFO, startedAt: 5_000 });
    expect(await runCli(["status"], deps)).toBe(0);
    expect(out[1]).toBe(`  up 1m9s, 0 sessions tracked, v${VERSION}`); // 69s from now − startedAt
  });
});

describe("url and open", () => {
  it("prints the url; open additionally launches the browser", async () => {
    const url = makeDeps({
      alive: (pid) => pid === 4242,
      responses: () => ({ ok: true, body: { ok: true } }),
    });
    writeServerInfo(url.deps.env, INFO);
    expect(await runCli(["url"], url.deps)).toBe(0);
    expect(url.out).toEqual(["observatory: http://127.0.0.1:8787"]);
    expect(url.opened).toEqual([]);

    const open = makeDeps({
      alive: (pid) => pid === 4242,
      responses: () => ({ ok: true, body: { ok: true } }),
    });
    writeServerInfo(open.deps.env, INFO);
    expect(await runCli(["open"], open.deps)).toBe(0);
    expect(open.opened).toEqual(["http://127.0.0.1:8787"]);
  });

  it("starts the server when none runs, then opens it (a first /observatory:open just works)", async () => {
    let childUp = false;
    const { deps, out, opened, spawned } = makeDeps({
      responses: () => (childUp ? { ok: true, body: { ok: true } } : { ok: false, body: null }),
      onSpawn: () => {
        childUp = true;
        writeServerInfo(deps.env, { pid: 555, port: 9003, url: "http://127.0.0.1:9003", startedAt: 3 });
      },
    });
    expect(await runCli(["open"], deps)).toBe(0);
    expect(spawned).toEqual([["start", "--foreground", "--since", "1d"]]);
    expect(out).toEqual(["observatory: http://127.0.0.1:9003"]);
    expect(opened).toEqual(["http://127.0.0.1:9003"]);
  });

  it("opens nothing when the server will not start", async () => {
    let ticks = 0;
    const { deps, opened } = makeDeps({ now: () => (ticks++ === 0 ? 0 : 16_000) });
    expect(await runCli(["open"], deps)).toBe(1);
    expect(opened).toEqual([]);
  });
});

describe("autostart", () => {
  it("is remembered by start and forgotten by stop, so the dashboard returns with the next session", async () => {
    const { deps } = makeDeps({
      alive: (pid) => pid === 4242,
      responses: () => ({ ok: true, body: { ok: true } }),
    });
    const env = { ...deps.env, OBSERVATORY_AUTOSTART: undefined };
    expect(wantsAutostart(env)).toBe(false); // installed, never started: the hooks start nothing
    writeServerInfo(deps.env, INFO);
    expect(await runCli(["start"], deps)).toBe(0);
    expect(wantsAutostart(env)).toBe(true);
    expect(wantsAutostart({ ...env, OBSERVATORY_AUTOSTART: "0" })).toBe(false); // the variable decides when set
    expect(await runCli(["stop"], deps)).toBe(0);
    expect(wantsAutostart(env)).toBe(false);
    expect(wantsAutostart({ ...env, OBSERVATORY_AUTOSTART: "1" })).toBe(true);
  });
});
