import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIds, createProcessControl, createSystemClock } from "../../src/adapters/system.ts";
import { descendants, parentTable } from "../support/proc-tree.ts";
import { until } from "../support/wait.ts";

describe("createSystemClock", () => {
  it("now and iso read the wall clock", () => {
    const clock = createSystemClock();

    const before = Date.now();
    const now = clock.now();
    const iso = clock.iso();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(iso)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(iso)).toBeLessThanOrEqual(after);
  });

  it("sleep waits at least ms and rejects with AbortError when aborted", async () => {
    const clock = createSystemClock();
    const controller = new AbortController();

    const started = performance.now();
    await clock.sleep(30);
    const waited = performance.now() - started;
    const aborted = clock.sleep(60_000, controller.signal);
    controller.abort();

    expect(waited).toBeGreaterThanOrEqual(29);
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("createIds", () => {
  it("jobId is the UTC yymmdd date, a dash and 6 lowercase Crockford base32 chars; ids are unique", () => {
    const ids = createIds();
    const day = (date: Date) => date.toISOString().slice(2, 10).replaceAll("-", "");

    const before = day(new Date());
    const jobIds = Array.from({ length: 200 }, () => ids.jobId());
    const after = day(new Date());

    for (const id of jobIds) {
      expect(id).toMatch(/^\d{6}-[0-9a-hjkmnp-tv-z]{6}$/);
      expect([before, after]).toContain(id.slice(0, 6));
    }
    expect(new Set(jobIds).size).toBe(jobIds.length);
  });

  it("sessionId is a fresh RFC 4122 v4 UUID (what claude --session-id accepts)", () => {
    const ids = createIds();

    const sessions = [ids.sessionId(), ids.sessionId()];

    for (const id of sessions)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessions[0]).not.toBe(sessions[1]);
  });
});

/** A detached group leader that starts one grandchild in its group, both optionally ignoring SIGTERM. */
const GROUP_SCRIPT = `
const { spawn } = process.getBuiltinModule("node:child_process");
const { writeFileSync } = process.getBuiltinModule("node:fs");
const stubborn = process.env.IGNORE_TERM === "1";
if (stubborn) process.on("SIGTERM", () => {});
const body = (stubborn ? 'process.on("SIGTERM", () => {});' : "") + "setInterval(() => {}, 1000);";
const grandchild = spawn(process.execPath, ["-e", body], { stdio: "ignore" });
writeFileSync(process.env.PIDS_FILE, process.pid + " " + grandchild.pid);
setInterval(() => {}, 1000);
`;

interface Group {
  readonly leader: ChildProcess;
  readonly pids: readonly number[];
}

/** Every group a test starts, so a failing test cannot leak processes. */
const started: number[] = [];

function killLeftovers(): void {
  for (const pid of started.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone: the expected case
    }
  }
}

async function startGroup(dir: string, ignoreTerm: boolean): Promise<Group> {
  const pidsFile = join(dir, `pids-${Math.random()}`);
  const leader = spawn(process.execPath, ["-e", GROUP_SCRIPT], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PIDS_FILE: pidsFile, IGNORE_TERM: ignoreTerm ? "1" : "0" },
  });
  started.push(leader.pid ?? -1);
  const content = await until(() => readFile(pidsFile, "utf8").catch(() => ""), {
    message: "the group did not report its pids",
  });
  return { leader, pids: content.split(" ").map(Number) };
}

describe("createProcessControl", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zai-proc-"));
  });
  afterEach(async () => {
    killLeftovers();
    await rm(dir, { recursive: true, force: true });
  });

  it("isAlive: true for a running process (even one we may not signal), false once it has exited", async () => {
    const control = createProcessControl("/unused/zai.js", (jobId) => `/unused/${jobId}.log`);
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid ?? -1;
    await once(child, "exit");

    expect(control.isAlive(process.pid)).toBe(true);
    expect(control.isAlive(1)).toBe(true);
    expect(control.isAlive(pid)).toBe(false);
  });

  it("isAlive: false for values that do not name one process (0 and negatives address groups, kill(-1) everyone)", () => {
    const control = createProcessControl("/unused/zai.js", (jobId) => `/unused/${jobId}.log`);

    expect([0, -1, -process.pid, 1.5, Number.NaN].map((pid) => control.isAlive(pid))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("terminateGroup: SIGTERM reaches the leader and its grandchildren; returns once the group is gone", async () => {
    const control = createProcessControl("/unused/zai.js", (jobId) => `/unused/${jobId}.log`);
    const group = await startGroup(dir, false);
    const exited = once(group.leader, "exit");

    await control.terminateGroup(group.leader.pid ?? -1, 5_000);

    expect(await exited).toEqual([null, "SIGTERM"]);
    for (const pid of group.pids) expect(control.isAlive(pid)).toBe(false);
  });

  it("terminateGroup: a group that ignores SIGTERM gets SIGKILL after graceMs", {
    timeout: 5_000,
  }, async () => {
    const control = createProcessControl("/unused/zai.js", (jobId) => `/unused/${jobId}.log`);
    const group = await startGroup(dir, true);
    const exited = once(group.leader, "exit");

    const started = performance.now();
    await control.terminateGroup(group.leader.pid ?? -1, 300);
    const took = performance.now() - started;

    expect(await exited).toEqual([null, "SIGKILL"]);
    expect(took).toBeGreaterThanOrEqual(290);
    for (const pid of group.pids) expect(control.isAlive(pid)).toBe(false);
  });

  it("terminateGroup: never signals for 0, 1, negatives, non-integers or its own pid (kill(-0)/kill(-1) hit others)", async () => {
    const control = createProcessControl("/unused/zai.js", (jobId) => `/unused/${jobId}.log`);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      for (const pid of [0, 1, -42, 1.5, Number.NaN, process.pid]) await control.terminateGroup(pid, 10);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("spawnDriver: starts `node <bundle> drive <id>` as its own group leader with stdout and stderr in the log", async () => {
    const bundle = join(dir, "zai.mjs");
    await writeFile(
      bundle,
      `import { execFileSync } from "node:child_process";
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
console.log(JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, pgid }));
console.error("driver stderr");
`,
    );
    const logPath = (jobId: string) => join(dir, "jobs", jobId, "driver.log");
    const control = createProcessControl(bundle, logPath);

    const pid = control.spawnDriver("261006-abc123");
    await until(() => !control.isAlive(pid), { message: "the driver did not exit" });
    const [stdout, stderr] = (await readFile(logPath("261006-abc123"), "utf8")).trim().split("\n");

    expect(JSON.parse(stdout ?? "")).toEqual({ argv: ["drive", "261006-abc123"], pid, pgid: pid });
    expect(stderr).toBe("driver stderr");
  });

  it("spawnDriver: the driver is an orphan, outside the caller's process tree, and still leads its own group", async () => {
    const bundle = join(dir, "zai.mjs");
    await writeFile(bundle, "setInterval(() => {}, 1000);\n");
    const control = createProcessControl(bundle, (jobId) => join(dir, `${jobId}.log`));

    const pid = control.spawnDriver("261006-abc123");
    started.push(pid);
    const table = parentTable();
    const [pgid] = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" })
      .trim()
      .split(/\s+/);

    expect(table.get(pid)).not.toBe(process.pid);
    expect(descendants(process.pid, table)).not.toContain(pid);
    expect(Number(pgid)).toBe(pid);
  });

  it("spawnDriver: throws when the runtime cannot be started instead of returning a bogus pid", () => {
    const control = createProcessControl(join(dir, "zai.mjs"), (jobId) => join(dir, `${jobId}.log`));
    const execPath = process.execPath;
    process.execPath = join(dir, "no-such-node");

    try {
      expect(() => control.spawnDriver("261006-abc123")).toThrow(`cannot start ${join(dir, "no-such-node")}`);
    } finally {
      process.execPath = execPath;
    }
  });
});
