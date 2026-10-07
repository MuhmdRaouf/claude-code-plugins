import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createFsEngineConfig } from "../../src/adapters/fs-engine-config.ts";
import { writeEnginePid } from "../../src/adapters/fs-job-files.ts";
import { activityBoard } from "../../src/app/activity.ts";
import type { Deps, EngineWorkers } from "../../src/app/deps.ts";
import { drive } from "../../src/app/drive.ts";
import { reapEngine, reapOrphanEngines } from "../../src/app/engine-reap.ts";
import { depsForJob, jobEngine, resolveEngine } from "../../src/app/engine-select.ts";
import { engineUsage, usage } from "../../src/app/queries.ts";
import { submit } from "../../src/app/submit.ts";
import { EXIT } from "../../src/cli/exit.ts";
import { runCli } from "../../src/cli/run.ts";
import type { EngineConfig, EngineTool } from "../../src/domain/engine.ts";
import type { Job } from "../../src/domain/job.ts";
import { aBrief, aJob, anAttempt } from "../support/builders.ts";
import { completes, EVENT_DIALECT, type Fakes, fakeDeps, ScriptedWorker, wire } from "../support/fakes.ts";
import { ACME_PROVIDER, REFERENCE_CAPS } from "../support/provider.ts";

const BRIEF = "---\ntitle: Rename foo\n---\nRename `foo` to `bar`.\n";

function brief(front: string): string {
  return `---\ntitle: Rename foo\n${front}\n---\nRename \`foo\` to \`bar\`.\n`;
}

/** A scripted engine per tool, each with terms of its own: omp's efforts only go up to max, like the real one. */
interface EngineFakes {
  readonly engines: EngineWorkers;
  readonly workers: Readonly<Record<EngineTool, ScriptedWorker>>;
}

function scriptedEngines(fakes: Fakes): EngineFakes {
  const worker = (name: "omp-rpc" | "opencode" | "pi-rpc", efforts: readonly [string, ...string[]]) =>
    new ScriptedWorker([completes()], fakes.process, {
      ...EVENT_DIALECT,
      caps: { ...REFERENCE_CAPS, name, sessionKey: "engine", nativeSchema: false, budget: false, efforts },
    });
  const workers = {
    omp: worker("omp-rpc", ["low", "high", "max"]),
    opencode: worker("opencode", ["low", "high", "max"]),
    pi: worker("pi-rpc", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  };
  return {
    workers,
    engines: {
      worker: (tool) => workers[tool],
      bin: (tool) => `/opt/${tool}/bin/${tool}`,
    },
  };
}

function withEngines(fakes: Fakes, engines: EngineWorkers): Deps {
  return { ...fakes.deps, engines };
}

function enable(fakes: Fakes, config: Partial<EngineConfig> = {}): void {
  createFsEngineConfig(fakes.root).write({
    engines: {
      omp: { watcher: "provider", version: "omp/18.6.3", path: "/opt/omp/bin/omp" },
      pi: { watcher: "sonnet", version: "pi 1.0.4", path: "/opt/pi/bin/pi" },
    },
    ...config,
  });
}

describe("engine selection", () => {
  it("is --engine, then the brief's engine:, then the configured default, then claude", async () => {
    const fakes = fakeDeps();
    const deps = withEngines(fakes, scriptedEngines(fakes).engines);
    enable(fakes);

    expect(resolveEngine(deps, undefined, BRIEF)).toEqual({ ok: true, value: "claude" });
    expect(resolveEngine(deps, undefined, brief("engine: pi"))).toEqual({ ok: true, value: "pi" });
    expect(resolveEngine(deps, "omp", brief("engine: pi"))).toEqual({ ok: true, value: "omp" });
    expect(resolveEngine(deps, "claude", brief("engine: pi"))).toEqual({ ok: true, value: "claude" });
    enable(fakes, { defaultEngine: "omp" });
    expect(resolveEngine(deps, undefined, BRIEF)).toEqual({ ok: true, value: "omp" });
    expect(resolveEngine(deps, undefined, brief("engine: claude"))).toEqual({ ok: true, value: "claude" });
  });

  it("an engine its setup command has not enabled is refused, naming that command, with exit 6", async () => {
    const fakes = fakeDeps();
    const deps = withEngines(fakes, scriptedEngines(fakes).engines);
    enable(fakes);
    writeBrief(fakes, "brief.md", BRIEF);

    expect(resolveEngine(deps, "opencode", BRIEF)).toEqual({
      ok: false,
      error: { kind: "engine_not_enabled", engine: "opencode" },
    });
    expect(await runCli(["run", `${fakes.root}/brief.md`, "--engine", "opencode"], deps, "/repo")).toBe(
      EXIT.notReady,
    );
    expect(fakes.out.errors).toEqual([
      "zai: the opencode engine is not enabled: run /zai:setup:opencode first",
    ]);
    expect(fakes.store.jobs.size).toBe(0);
  });

  it("every provider offers every engine: no engine is refused for the provider it runs beside", async () => {
    const fakes = fakeDeps([completes()], {}, { provider: ACME_PROVIDER });
    const deps = withEngines(fakes, scriptedEngines(fakes).engines);
    enable(fakes, {
      engines: Object.fromEntries(
        (["omp", "opencode", "pi"] as const).map((tool) => [
          tool,
          { watcher: "sonnet", version: "1", path: tool },
        ]),
      ),
    });

    for (const tool of ["omp", "opencode", "pi"] as const) {
      const submitted = await submit(deps, { text: brief(`engine: ${tool}`), cwd: "/repo" });
      expect(submitted.ok && submitted.value.brief.engine).toBe(tool);
    }
  });

  it("an unknown --engine is a usage error; an unknown engine: is a brief error", async () => {
    const fakes = fakeDeps();
    writeBrief(fakes, "brief.md", brief("engine: cursor"));

    expect(await runCli(["run", `${fakes.root}/brief.md`, "--engine", "cursor"], fakes.deps, "/repo")).toBe(
      EXIT.usage,
    );
    expect(fakes.out.errors[0]).toBe("zai: --engine must be one of claude, omp, opencode, pi");
    expect(await runCli(["run", `${fakes.root}/brief.md`], fakes.deps, "/repo")).toBe(EXIT.usage);
    expect(fakes.out.errors.at(-1)).toBe(
      "zai: invalid brief: engine: must be one of claude, omp, opencode, pi",
    );
  });

  it("the job records a delegation engine; claude stays implicit so a claude brief reads as before", async () => {
    const fakes = fakeDeps();
    const deps = withEngines(fakes, scriptedEngines(fakes).engines);
    enable(fakes, { defaultEngine: "pi" });

    const onPi = await submit(deps, { text: BRIEF, cwd: "/repo" });
    const onOmp = await submit(deps, { text: BRIEF, cwd: "/repo", overrides: { engine: "omp" } });
    const onClaude = await submit(deps, { text: brief("engine: claude"), cwd: "/repo" });

    expect(onPi.ok && onPi.value.brief.engine).toBe("pi");
    expect(onOmp.ok && onOmp.value.brief.engine).toBe("omp");
    expect(onClaude.ok && "engine" in onClaude.value.brief).toBe(false);
    expect(onClaude.ok && jobEngine(onClaude.value)).toBe("claude");
  });

  it("checks the brief against the engine's own terms: an effort pi has and claude lacks", async () => {
    const fakes = fakeDeps();
    const deps = withEngines(fakes, scriptedEngines(fakes).engines);
    enable(fakes);

    const onPi = await submit(deps, { text: brief("engine: pi\neffort: xhigh"), cwd: "/repo" });
    const onClaude = await submit(deps, { text: brief("effort: xhigh"), cwd: "/repo" });

    expect(onPi.ok && onPi.value.brief.effort).toBe("xhigh");
    expect(onClaude.ok).toBe(false);
  });
});

describe("driving a job on an engine", () => {
  it.each(["omp", "opencode", "pi"] as const)(
    "%s: the job's engine runs it; claude's worker is never started",
    async (tool) => {
      const fakes = fakeDeps();
      const scripted = scriptedEngines(fakes);
      const deps = withEngines(fakes, scripted.engines);
      enable(fakes, { engines: { [tool]: { watcher: "sonnet", version: "1", path: tool } } });
      const submitted = await submit(deps, { text: brief(`engine: ${tool}`), cwd: "/repo" });
      if (!submitted.ok) throw new Error("submit failed");

      const driven = await drive(deps, submitted.value.id);

      expect(driven.ok && driven.value.state).toBe("awaiting_review");
      expect(driven.ok && driven.value.attempts[0]?.verdict).toBe("pass");
      expect(scripted.workers[tool].specs).toHaveLength(1);
      expect(scripted.workers[tool].disposed).toBe(1);
      expect(fakes.worker.specs).toHaveLength(0);
    },
  );

  it("an engine this process cannot build fails the attempt visibly instead of running on claude", async () => {
    const fakes = fakeDeps();
    const job = fakes.store.put(aJob({ id: "j1", brief: aBrief({ engine: "omp" }) }));

    const deps = depsForJob(fakes.deps, job);
    const started = await deps.worker.start({} as never);

    expect(started).toEqual({
      ok: false,
      error: { kind: "unsupported", message: "the omp engine is not available here" },
    });
    expect(await deps.worker.preflight()).toEqual(started);
    expect(deps.worker.parseLine("{}")).toEqual([]);
    await deps.worker.dispose();
    expect(depsForJob(fakes.deps, aJob()).worker).toBe(fakes.worker);
  });
});

describe("reaping engine processes", () => {
  it("cleanup terminates the engine group of a job whose driver is dead, and forgets it", async () => {
    const fakes = fakeDeps();
    const job = fakes.store.put(aJob({ id: "j1", state: "running", brief: aBrief({ engine: "omp" }) }));
    const engine = 61_234;
    fakes.process.alive.add(engine);
    writeEnginePid(fakes.store.paths(job.id).enginePid, engine);
    fakes.store.holdLock(job.id, 99_999_001);

    await reapOrphanEngines(fakes.deps, [job]);

    expect(fakes.process.terminated).toEqual([engine]);
    await reapEngine(fakes.deps, job.id);
    expect(fakes.process.terminated).toEqual([engine]);
  });

  it("cleanup leaves the engine of a live driver alone", async () => {
    const fakes = fakeDeps();
    const job = fakes.store.put(aJob({ id: "j1", state: "running", brief: aBrief({ engine: "pi" }) }));
    fakes.process.alive.add(61_235);
    writeEnginePid(fakes.store.paths(job.id).enginePid, 61_235);
    fakes.store.holdLock(job.id, process.pid);

    await reapOrphanEngines(fakes.deps, [job]);

    expect(fakes.process.terminated).toEqual([]);
  });

  it("discard terminates the engine group after the driver that held the job is gone", async () => {
    const fakes = fakeDeps();
    const job = fakes.store.put(aJob({ id: "j1", state: "running", brief: aBrief({ engine: "opencode" }) }));
    fakes.process.alive.add(61_236);
    writeEnginePid(fakes.store.paths(job.id).enginePid, 61_236);

    expect(await runCli(["discard", "j1"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.process.terminated).toContain(61_236);
  });

  it("stop of a job with no live driver terminates its engine too", async () => {
    const fakes = fakeDeps();
    const job = fakes.store.put(aJob({ id: "j1", state: "running", brief: aBrief({ engine: "omp" }) }));
    fakes.process.alive.add(61_237);
    writeEnginePid(fakes.store.paths(job.id).enginePid, 61_237);

    expect(await runCli(["stop", "j1"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.process.terminated).toContain(61_237);
  });
});

describe("board and usage engine rows", () => {
  function engineJob(id: string, engine: EngineTool | undefined, state: Job["state"], model?: string): Job {
    const usageOf = {
      turns: 3,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    };
    return aJob({
      id,
      state,
      brief: aBrief(engine === undefined ? {} : { engine }),
      workspace: { ...aJob().workspace, repoRoot: "/repo" },
      attempts: [
        anAttempt({
          usage: {
            ...usageOf,
            costUsd: 0.25,
            rateLimitRetries: 0,
            durationMs: 1000,
            ...(model === undefined ? {} : { model }),
          },
        }),
      ],
      updatedAt: "2026-10-06T00:00:00.000Z",
    });
  }

  it("an engine job shows its engine as KIND, the tool's own model and numbers, and its pid while the driver lives", async () => {
    const fakes = fakeDeps();
    fakes.store.put(engineJob("j1", "omp", "running", "openrouter/qwen-coder"));
    fakes.store.put(engineJob("j2", undefined, "accepted"));
    fakes.store.put(engineJob("j3", "pi", "awaiting_review"));
    fakes.store.holdLock("j1", process.pid);
    writeEnginePid(fakes.store.paths("j1").enginePid, 61_300);
    writeEnginePid(fakes.store.paths("j3").enginePid, 61_301);

    const rows = await activityBoard(fakes.deps, { repoRoot: "/repo", all: false });

    expect(rows.map((row) => [row.kind, row.id, row.pid, row.model, row.requests])).toEqual([
      // The tool runs on its own setup: its row names the model the tool reported, never the provider's catalog.
      ["omp", "j1", 61_300, "openrouter/qwen-coder", 3],
      ["job", "j2", undefined, "glm-5.3", 3],
      ["pi", "j3", undefined, undefined, 3],
    ]);
    expect(await runCli(["board"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.out.text).toMatch(/omp +j1 +openrouter\/qwen-coder +running \(pid 61300\) +3 +100 +20 /);
    expect(fakes.out.text).toMatch(/pi +j3 +- +review: no verdict +3 +100 +20 /);
    expect(fakes.out.text).toContain(
      "omp, pi rows: model and numbers as the tool itself reports them (it runs on its own setup).",
    );
  });

  it("usage keeps the claude ledger to claude jobs and adds one row per engine", async () => {
    const fakes = fakeDeps();
    fakes.store.put(engineJob("j1", "omp", "accepted", "zai/glm-5.3"));
    fakes.store.put(engineJob("j2", "omp", "discarded", "anthropic/claude-sonnet"));
    fakes.store.put(engineJob("j3", undefined, "accepted"));

    const scope = { repoRoot: "/repo", all: false };
    expect((await usage(fakes.deps, scope)).map((row) => row.jobs)).toEqual([1]);
    expect(await engineUsage(fakes.deps, scope)).toEqual([
      {
        engine: "omp",
        models: ["anthropic/claude-sonnet", "zai/glm-5.3"],
        jobs: 2,
        accepted: 1,
        requests: 6,
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        costUsd: 0.5,
      },
    ]);
    expect(await runCli(["usage"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.out.text).toContain(
      "zai engines (as each tool reports them; the tools run on their own setup)\n",
    );
    expect(fakes.out.text).toContain("Jobs on omp, opencode or pi are not in the total");
    expect(fakes.out.text).toMatch(/ENGINE +MODEL +JOBS +ACCEPTED +REQ +IN +OUT +CACHE R +CACHE W +COST/);
    const ompLine = fakes.out.text.split("\n").find((line) => line.startsWith("omp"));
    expect(ompLine?.split(/\s+/)).toEqual([
      "omp",
      "anthropic/claude-sonnet,",
      "zai/glm-5.3",
      "2",
      "1",
      "6",
      "200",
      "40",
      "20",
      "10",
      "$0.5000",
    ]);
    expect(await runCli(["usage", "--json"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(JSON.parse(fakes.out.lines.at(-1) ?? "{}").engines).toHaveLength(1);
  });

  it("with no engine jobs, usage has no engines section and no engines key", async () => {
    const fakes = fakeDeps();
    fakes.store.put(engineJob("j3", undefined, "accepted"));

    expect(await runCli(["usage", "--json"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(Object.keys(JSON.parse(fakes.out.lines.at(-1) ?? "{}"))).toEqual([
      "estimate",
      "spool",
      "jobs",
      "routerHealth",
    ]);
    expect(await runCli(["usage"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.out.text).not.toContain("engines");
  });

  it("an engine job's live progress is folded by its own engine's parser", async () => {
    const fakes = fakeDeps();
    const scripted = scriptedEngines(fakes);
    const deps = withEngines(fakes, scripted.engines);
    const job = fakes.store.put(
      aJob({ id: "j1", state: "running", brief: aBrief({ engine: "pi" }), attempts: [anAttempt()] }),
    );
    writeLog(fakes, job, [wire.text("from pi")]);

    expect(await runCli(["show", "j1", "--json"], deps, "/repo")).toBe(EXIT.ok);
    expect(JSON.parse(fakes.out.lines.at(-1) ?? "{}").progress.lastText).toBe("from pi");
  });
});

function writeBrief(fakes: Fakes, name: string, text: string): void {
  writeFileSyncAt(`${fakes.root}/${name}`, text);
}

function writeLog(fakes: Fakes, job: Job, lines: readonly string[]): void {
  writeFileSyncAt(fakes.store.paths(job.id).attemptLog(1), `${lines.join("\n")}\n`);
}

function writeFileSyncAt(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
