import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enginePidBeside, stateLayout } from "../../src/domain/state-layout.ts";

// The names are the on-disk contract: an installed plugin, its router and an older version of either read the same
// files, so renaming one is a migration, not a refactor.
describe("stateLayout names every file a plugin keeps under its state root", () => {
  const root = "/state";
  const layout = stateLayout(root);

  it("names the setup, engine, ledger and router files", () => {
    expect({ ...layout, job: undefined }).toEqual({
      root,
      setupDone: join(root, "setup-done"),
      legacyRouteMark: join(root, "route"),
      engines: join(root, "engines.json"),
      ledger: join(root, "ledger.json"),
      disabledLedger: join(root, "ledger.disabled.json"),
      routerDir: join(root, "router"),
      routerLog: join(root, "router", "router.log"),
      routerPid: join(root, "router.pid"),
      routerLock: join(root, "router.lock"),
      crashLog: join(root, "router-crash.log"),
      leftBehind: join(root, "LEFT-BEHIND.md"),
      claudeHome: join(root, "claude-home"),
      limiter: join(root, "limiter.json"),
      slots: join(root, "slots"),
      jobs: join(root, "jobs"),
      checkouts: join(root, "checkouts"),
      job: undefined,
    });
  });

  it("puts a job's record and sidecars in its directory and its worktree beside the jobs", () => {
    const job = layout.job("261008-abc123");
    const dir = join(root, "jobs", "261008-abc123");
    expect({
      ...job,
      attemptLog: job.attemptLog(2),
      gateLog: job.gateLog(2, 1),
      regenerateLog: job.regenerateLog(0),
      landCheckLog: job.landCheckLog(1),
    }).toEqual({
      dir,
      record: join(dir, "job.json"),
      brief: join(dir, "brief.md"),
      artifacts: join(dir, "artifacts"),
      attemptLog: join(dir, "attempt-2.jsonl"),
      gateLog: join(dir, "gate-2-1.log"),
      regenerateLog: join(dir, "regenerate-0.log"),
      landCheckLog: join(dir, "land-check-1.log"),
      driverLog: join(dir, "driver.log"),
      stop: join(dir, "stop"),
      progress: join(dir, "progress.json"),
      driverLock: join(dir, "driver.lock"),
      enginePid: join(dir, "engine.pid"),
      worktree: join(root, "worktrees", "261008-abc123"),
      checkout: join(root, "checkouts", "261008-abc123"),
    });
    expect(enginePidBeside(job.attemptLog(3))).toBe(job.enginePid);
  });
});
