// The router's small records: the crash log and router log, the pid file, the ledger, and the per-prompt ensure check.
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stateLayout } from "../../src/domain/state-layout.ts";
import {
  CRASH_LOG_LIMIT,
  diskFs,
  installCrashHandlers,
  type LogFs,
  logCrash,
  rotatingLog,
} from "../../src/router/crashlog.ts";
import { ensureRouter } from "../../src/router/ensure.ts";
import {
  type Ledger,
  mergeSettingsUndo,
  readLedger,
  removeLedger,
  writeLedger,
} from "../../src/router/ledger.ts";
import { readPidFile, removePidFile, writePidFile } from "../../src/router/pidfile.ts";
import { freePort } from "../../src/router/process.ts";
import { tempDir } from "../support/tmp.ts";

const full: LogFs = {
  append: () => {
    throw Object.assign(new Error("no space"), { code: "ENOSPC" });
  },
  size: () => {
    throw new Error("no stat");
  },
  read: () => Buffer.alloc(0),
  write: () => undefined,
  rename: () => {
    throw new Error("no rename");
  },
};

describe("the crash log", () => {
  it("appends one JSON line per entry, never a header or body, and keeps only the last bytes", () => {
    const root = tempDir("router-log-");
    logCrash(root, { role: "front", version: "v1", event: "worker exited" });
    const line = JSON.parse(readFileSync(stateLayout(root).crashLog, "utf8").trim()) as Record<
      string,
      unknown
    >;
    expect(line).toMatchObject({ role: "front", version: "v1", event: "worker exited", pid: process.pid });
    expect(statSync(stateLayout(root).crashLog).mode & 0o777).toBe(0o600);
    for (let i = 0; i < 50; i++)
      logCrash(root, { role: "worker", version: "v1", error: `boom ${i}` }, diskFs, 400);
    const kept = readFileSync(stateLayout(root).crashLog, "utf8");
    expect(kept.length).toBeLessThanOrEqual(400);
    expect(kept.endsWith("\n")).toBe(true);
    expect(kept.split("\n")[0]?.startsWith("{")).toBe(true);
    expect(kept).toContain("boom 49");
    expect(CRASH_LOG_LIMIT).toBe(1024 * 1024);
  });

  it("swallows a full disk", () => {
    expect(() => logCrash(tempDir("router-log-"), { role: "emergency", version: "x" }, full)).not.toThrow();
  });

  it("logs an uncaught exception or rejection with its stack, then exits 1", () => {
    const root = tempDir("router-log-");
    const exits: number[] = [];
    const before = {
      exception: process.listeners("uncaughtException"),
      rejection: process.listeners("unhandledRejection"),
    };
    installCrashHandlers("worker", root, "v9", (code) => exits.push(code));
    const added = {
      exception: process.listeners("uncaughtException").filter((l) => !before.exception.includes(l)),
      rejection: process.listeners("unhandledRejection").filter((l) => !before.rejection.includes(l)),
    };
    try {
      (added.exception[0] as (error: unknown) => void)(new Error("kaput"));
      (added.rejection[0] as (error: unknown) => void)("plain reason");
    } finally {
      for (const listener of added.exception) process.removeListener("uncaughtException", listener);
      for (const listener of added.rejection) process.removeListener("unhandledRejection", listener);
    }
    expect(exits).toEqual([1, 1]);
    const lines = readFileSync(stateLayout(root).crashLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      role: "worker",
      event: "uncaughtException",
      error: "kaput",
      stack: expect.any(String),
    });
    expect(lines[1]).toMatchObject({ event: "unhandledRejection", error: "plain reason" });
  });
});

describe("the router log", () => {
  it("rotates to .1 past its limit and never throws, not even on a full disk", () => {
    const root = tempDir("router-log-");
    const path = join(root, "router.log");
    const log = rotatingLog(path, diskFs, 200);
    for (let i = 0; i < 10; i++) log(`request ${i} ${"x".repeat(20)}`);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(path).size).toBeLessThanOrEqual(200);
    expect(() => rotatingLog(path, full, 10)("line")).not.toThrow();
  });

  it("does not bring back a directory that was removed", () => {
    const root = tempDir("router-log-");
    rotatingLog(join(root, "gone", "router.log"))("line");
    expect(existsSync(join(root, "gone"))).toBe(false);
  });
});

describe("the pid file", () => {
  it("round-trips 0600 and refuses anything else", () => {
    const root = tempDir("router-pid-");
    expect(readPidFile(root)).toBeUndefined();
    const record = {
      pid: 1,
      port: 2,
      startedAt: "t",
      node: "/node",
      version: "v",
      frontVersion: 1,
      mode: "router" as const,
      token: "x",
    };
    writePidFile(root, record);
    expect(readPidFile(root)).toEqual(record);
    expect(statSync(stateLayout(root).routerPid).mode & 0o777).toBe(0o600);
    writeFileSync(stateLayout(root).routerPid, '{"pid":"one"}');
    expect(readPidFile(root)).toBeUndefined();
    writeFileSync(stateLayout(root).routerPid, "null");
    expect(readPidFile(root)).toBeUndefined();
    removePidFile(root);
    expect(existsSync(stateLayout(root).routerPid)).toBe(false);
  });
});

describe("the ledger", () => {
  const ledger = (root: string): Ledger => ({
    version: 1,
    plugin: "acme",
    routerUrl: "http://127.0.0.1:18800",
    settingsPath: "/s.json",
    settings: {
      optionsAdded: ["a"],
      availableAppended: [],
      createdModelPicker: true,
      createdOptions: true,
      createdEnv: false,
    },
    keystore: { created: false },
    routerFiles: [],
    stateRoot: root,
  });

  it("round-trips, refuses what is not a ledger, and goes away", () => {
    const root = tempDir("router-ledger-");
    writeLedger(stateLayout(root).ledger, ledger(root));
    expect(readLedger(stateLayout(root).ledger)).toEqual(ledger(root));
    expect(statSync(stateLayout(root).ledger).mode & 0o777).toBe(0o600);
    for (const text of ["nope", "null", '{"version":2}', '{"version":1,"plugin":"a","routerUrl":"u"}']) {
      writeFileSync(stateLayout(root).disabledLedger, text);
      expect(readLedger(stateLayout(root).disabledLedger)).toBeUndefined();
    }
    removeLedger(stateLayout(root).ledger);
    expect(readLedger(stateLayout(root).ledger)).toBeUndefined();
  });

  it("merges setup runs: the first known 'before' wins, additions add up", () => {
    expect(mergeSettingsUndo(undefined, undefined)).toEqual({
      optionsAdded: [],
      availableAppended: [],
      createdModelPicker: false,
      createdOptions: false,
      createdEnv: false,
    });
    const first = mergeSettingsUndo(undefined, {
      baseUrlBefore: null,
      optionsAdded: ["a"],
      availableAppended: ["a"],
      createdModelPicker: true,
      createdOptions: false,
      createdEnv: true,
    });
    const second = mergeSettingsUndo(first, {
      baseUrlBefore: "http://127.0.0.1:18788",
      optionsAdded: ["b"],
      availableAppended: [],
      createdModelPicker: false,
      createdOptions: true,
      createdEnv: false,
    });
    expect(second).toEqual({
      baseUrlBefore: null,
      optionsAdded: ["a", "b"],
      availableAppended: ["a"],
      createdModelPicker: true,
      createdOptions: true,
      createdEnv: true,
    });
  });
});

describe("ensure (the per-prompt check)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("does nothing for a plugin never set up, nothing when the router answers, and starts it when refused", async () => {
    const root = tempDir("router-ensure-");
    const port = await freePort();
    const started: string[][] = [];
    const options = {
      name: "acme",
      envPrefix: "ACME",
      defaultPort: 1,
      env: { ACME_STATE_DIR: root, ACME_ROUTER_PORT: String(port) },
      routerScript: "/dist/acme-router.js",
      node: "/node",
      start: (node: string, args: readonly string[]) => started.push([node, ...args]),
    };
    expect(await ensureRouter(options)).toBe("skipped");
    writeFileSync(join(root, "setup-done"), "true\n");
    expect(await ensureRouter(options)).toBe("started");
    expect(started).toEqual([["/node", "/dist/acme-router.js", "start"]]);
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    expect(await ensureRouter(options)).toBe("up");
  });

  it("starts a real detached process by default, and returns at once", async () => {
    const root = tempDir("router-ensure-");
    writeFileSync(join(root, "router.pid"), "{}");
    const marker = join(root, "ran");
    const script = join(root, "router.js");
    writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.argv[2]);\n`);
    chmodSync(script, 0o600);
    const started = Date.now();
    expect(
      await ensureRouter({
        name: "acme",
        envPrefix: "ACME",
        defaultPort: await freePort(),
        env: { ACME_STATE_DIR: root, PATH: process.env.PATH },
        routerScript: script,
      }),
    ).toBe("started");
    expect(Date.now() - started).toBeLessThan(1000);
    for (let i = 0; i < 100 && !existsSync(marker); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readFileSync(marker, "utf8")).toBe("start");
  });
});
