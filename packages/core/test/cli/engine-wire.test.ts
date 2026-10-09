import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import { readEnginePid as enginePid } from "../../src/adapters/fs-job-files.ts";
import { isAlive, terminateGroup } from "../../src/adapters/process/group.ts";
import type { Deps } from "../../src/app/deps.ts";
import { drive } from "../../src/app/drive.ts";
import { reapOrphanEngines } from "../../src/app/engine-reap.ts";
import { builtinContract } from "../../src/app/report-schema.ts";
import { engineWorkers } from "../../src/cli/engine-wire.ts";
import type { EngineTool } from "../../src/domain/engine.ts";
import type { Job } from "../../src/domain/job.ts";
import type { ProcessControl, WorkerRun } from "../../src/ports/index.ts";
import { aBrief, aJob } from "../support/builders.ts";
import { type Fakes, fakeDeps } from "../support/fakes.ts";
import { ACME_PROVIDER, REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";

const FIXTURES = join(import.meta.dirname, "../fixtures/engines");
const NOTES = { summary: "pong", findings: [], open_items: [] };

/** Per engine: the fake standing in for it, the env that makes it finish with a notes report, and the one that makes
 *  it hang until it is stopped. */
const FAKES: Readonly<
  Record<EngineTool, { bin: string; finishes: Record<string, string>; hangs: Record<string, string> }>
> = {
  omp: {
    bin: join(FIXTURES, "fake-omp.ts"),
    finishes: { FAKE_OMP_FINAL_TEXT: JSON.stringify(NOTES) },
    hangs: { FAKE_OMP_SCENARIO: "sleep" },
  },
  pi: {
    bin: join(FIXTURES, "fake-pi.ts"),
    finishes: { FAKE_PI_FINAL_TEXT: JSON.stringify(NOTES) },
    hangs: { FAKE_PI_SCENARIO: "sleep" },
  },
  opencode: {
    bin: join(FIXTURES, "fake-opencode.ts"),
    finishes: { FAKE_OPENCODE_FIXTURE: join(FIXTURES, "opencode/happy.jsonl") },
    hangs: { FAKE_OPENCODE_FIXTURE: join(FIXTURES, "opencode/happy.jsonl"), FAKE_OPENCODE_HANG: "1" },
  },
};
const TOOLS = ["omp", "opencode", "pi"] as const;

const REAL_PROCESS: ProcessControl = {
  isAlive,
  terminateGroup,
  spawnDriver: () => {
    throw new Error("no driver in this test");
  },
};

/** Whether any member of the group led by `pid` is still there. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Real engine workers over the fakes, with the scenario passed the way a brief passes env: by name. */
function engineWorld(tool: EngineTool, scenario: Record<string, string>): { fakes: Fakes; deps: Deps } {
  const fakes = fakeDeps([], {
    ...scenario,
    PATH: process.env.PATH,
    [`ZAI_${tool.toUpperCase()}_BIN`]: FAKES[tool].bin,
  });
  const engines = engineWorkers({
    provider: REFERENCE_PROVIDER,
    env: fakes.deps.env,
    stopGraceMs: 2_000,
  });
  return { fakes, deps: { ...fakes.deps, engines, process: REAL_PROCESS } };
}

/** A readonly notes job on the engine in a real directory, every scenario variable passed through brief env. */
function engineJob(fakes: Fakes, tool: EngineTool, scenario: Record<string, string>): Job {
  const repo = tempDir("engine-repo-");
  const paths = fakes.store.paths("j1");
  mkdirSync(paths.artifacts, { recursive: true });
  return fakes.store.put(
    aJob({
      id: "j1",
      brief: aBrief({
        engine: tool,
        mode: "readonly",
        model: "flash",
        scope: [],
        report: { kind: "builtin", name: "notes" },
        retries: { fix: 0, infra: 0 },
        env: Object.keys(scenario),
        timeoutMs: 60_000,
      }),
      workspace: { repoRoot: repo, baseSha: "b".repeat(40), artifactsDir: paths.artifacts },
    }),
  );
}

async function pidOnceRunning(file: string): Promise<number> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const pid = enginePid(file);
    if (pid !== undefined) return pid;
    expect(Date.now(), "the engine never recorded its pid").toBeLessThan(deadline);
    await delay(25);
  }
}

describe.each(TOOLS)("the %s engine, as the user set it up, through the fake", (tool) => {
  it("drives a job to review on the engine; afterwards no engine process is left and the pid is forgotten", async () => {
    const { finishes } = FAKES[tool];
    const { fakes, deps } = engineWorld(tool, finishes);
    const job = engineJob(fakes, tool, finishes);

    const driven = await drive(deps, job.id);

    expect(driven.ok && driven.value.state).toBe("awaiting_review");
    expect(driven.ok && driven.value.attempts[0]?.outcome).toEqual({ kind: "completed" });
    expect(driven.ok && (driven.value.attempts[0]?.usage?.turns ?? 0)).toBeGreaterThan(0);
    // The model is the tool's own report: omp and pi name theirs, opencode's run output names none.
    expect(driven.ok && driven.value.attempts[0]?.usage?.model).toBe(
      tool === "opencode" ? undefined : "zai/glm-5.3",
    );
    expect(existsSync(fakes.store.paths(job.id).enginePid)).toBe(false);
    expect(fakes.worker.specs).toHaveLength(0);
  }, 60_000);

  it("a stop mid-run ends the job and kills the engine's whole process group", async () => {
    const { hangs } = FAKES[tool];
    const { fakes, deps } = engineWorld(tool, hangs);
    const job = engineJob(fakes, tool, hangs);
    const stop = new AbortController();

    const driving = drive(deps, job.id, stop.signal);
    const pid = await pidOnceRunning(fakes.store.paths(job.id).enginePid);
    stop.abort();
    const driven = await driving;

    expect(driven.ok && driven.value.attempts[0]?.verdict).toBe("stopped");
    expect(groupAlive(pid)).toBe(false);
  }, 60_000);

  it("after the driver died, the cleanup pass kills the engine's process group", async () => {
    const { hangs } = FAKES[tool];
    const { fakes, deps } = engineWorld(tool, hangs);
    const job = engineJob(fakes, tool, hangs);
    const worker = deps.engines?.worker(tool);
    if (worker === undefined) throw new Error(`no ${tool} worker`);
    const started = await worker.start({
      cwd: job.workspace.repoRoot,
      model: REFERENCE_PROVIDER.catalog.flash,
      access: "readonly",
      prompt: "Wait.",
      session: { kind: "new", key: "00000000-0000-7000-8000-0000000000d1" },
      report: builtinContract("notes"),
      addDirs: [],
      passEnv: hangs,
      timeoutMs: 60_000,
      logPath: fakes.store.paths(job.id).attemptLog(1),
    });
    if (!started.ok) throw new Error(JSON.stringify(started.error));
    const run: WorkerRun = started.value;
    onTestFinished(async () => {
      if (groupAlive(run.pid)) await terminateGroup(run.pid, 500);
    });
    const file = fakes.store.paths(job.id).enginePid;
    expect(await pidOnceRunning(file)).toBe(run.pid);
    // The driver that held the job is gone: its pid is in the lock file, but nothing answers to it.
    fakes.store.holdLock(job.id, 2 ** 22 + 12_345);

    await reapOrphanEngines(deps, [job]);
    await run.exit;

    expect(groupAlive(run.pid)).toBe(false);
    expect(enginePid(file)).toBeUndefined();
  }, 60_000);
});

/** The scenario plus a recorder of the tool's argv and environment, per fake. */
function recorders(tool: EngineTool, dir: string): Record<string, string> {
  const prefix = `FAKE_${tool.toUpperCase()}`;
  return {
    ...FAKES[tool].finishes,
    [`${prefix}_ARGV_LOG`]: join(dir, "argv.json"),
    [`${prefix}_ENV_LOG`]: join(dir, "env.json"),
  };
}

describe("engine workers", () => {
  it("every provider offers all three tools the same way", () => {
    const fakes = fakeDeps([], { ACME_OMP_BIN: "/opt/omp" }, { provider: ACME_PROVIDER });
    const engines = engineWorkers({ provider: ACME_PROVIDER, env: fakes.deps.env, stopGraceMs: 100 });

    expect(TOOLS.map((tool) => engines.worker(tool).caps.name)).toEqual(["omp-rpc", "opencode", "pi-rpc"]);
    expect(engines.bin("omp")).toBe("/opt/omp");
    expect(engines.bin("opencode")).toBe("opencode");
  });

  it.each(TOOLS)(
    "%s gets no provider key, base URL, model or config of the plugin's",
    async (tool) => {
      const dir = tempDir("engine-env-");
      const parent = {
        PATH: process.env.PATH,
        HOME: dir,
        OPENROUTER_API_KEY: "users-own-key",
        ZAI_API_KEY: "plugin-provider-key",
        ZAI_BASE_URL: REFERENCE_PROVIDER.baseUrl,
        ZAI_MODEL_MAIN: "glm-9",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:18787",
        ANTHROPIC_AUTH_TOKEN: "router-token",
        CLAUDECODE: "1",
        [`ZAI_${tool.toUpperCase()}_BIN`]: FAKES[tool].bin,
      };
      const engines = engineWorkers({ provider: REFERENCE_PROVIDER, env: parent, stopGraceMs: 500 });
      const worker = engines.worker(tool);
      const started = await worker.preflight().then(() =>
        worker.start({
          cwd: dir,
          model: REFERENCE_PROVIDER.catalog.main,
          access: "write",
          prompt: "Hi.",
          session: { kind: "new", key: "00000000-0000-7000-8000-0000000000d2" },
          report: builtinContract("notes"),
          addDirs: [],
          passEnv: { ...recorders(tool, dir), ZAI_API_KEY: "brief-supplied" },
          timeoutMs: 30_000,
          logPath: join(dir, "attempt-1.jsonl"),
        }),
      );
      if (!started.ok) throw new Error(`${tool} did not start: ${JSON.stringify(started.error)}`);
      for await (const _event of started.value.events) {
        // drained
      }
      await started.value.exit;

      const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
      const env = JSON.parse(readFileSync(join(dir, "env.json"), "utf8")) as Record<string, string>;
      expect(env).toMatchObject({ HOME: dir, OPENROUTER_API_KEY: "users-own-key" });
      for (const name of REFERENCE_PROVIDER.keyEnv) expect(env).not.toHaveProperty(name);
      expect(
        Object.keys(env).filter((name) => name.startsWith("ZAI_") || name.startsWith("ANTHROPIC_")),
      ).toEqual([]);
      const wire = JSON.stringify([argv, env]);
      for (const leak of ["plugin-provider-key", "brief-supplied", "api.z.ai", "18787", "glm-5.3", "glm-9"])
        expect(wire).not.toContain(leak);
      expect(argv).not.toContain("--model");
      expect(argv).not.toContain("-m");
      // No per-process config of the tool's: nothing written beside the attempt log.
      expect(existsSync(join(dir, "engine"))).toBe(false);
    },
    60_000,
  );
});
