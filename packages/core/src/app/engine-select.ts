/**
 * Which engine a job runs on and the worker that runs it. The job's engine is `run --engine` > the brief's `engine:`
 * > the config's `defaultEngine` > claude; a delegation engine must be enabled by its setup command (every provider
 * offers all three, each run as the user set it up). Everything past submission reads the engine from the job, so
 * drive, gates, review and the decisions stay engine-agnostic.
 */
import { isMap, parseDocument } from "yaml";
import { splitFrontMatter } from "../domain/brief-front-matter.ts";
import { type Engine, type EngineTool, engineEnabled, isEngine } from "../domain/engine.ts";
import type { Job } from "../domain/job.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Worker, WorkerCapabilities } from "../ports/index.ts";
import type { Deps } from "./deps.ts";
import type { AppError } from "./errors.ts";

/** The engine a stored job runs on: absent (every job from before engines) means claude. */
export function jobEngine(job: Job): Engine {
  return job.brief.engine ?? "claude";
}

/** The worker for an engine: claude's own, or the tool's; undefined when this process wired no engines. */
export function workerOf(deps: Deps, engine: Engine): Worker | undefined {
  return engine === "claude" ? deps.worker : deps.engines?.worker(engine);
}

/** The deps a job's driver runs with: the job's engine as the worker. An engine that cannot run here refuses to
 *  start, so the attempt fails visibly instead of running on another engine. */
export function depsForJob(deps: Deps, job: Job): Deps {
  const engine = jobEngine(job);
  if (engine === "claude") return deps;
  return { ...deps, worker: workerOf(deps, engine) ?? unavailable(deps.worker.caps, engine) };
}

/** The engine `engine:` names in the brief's front matter, when it names a known one; the schema reports the rest. */
export function briefEngine(text: string): Engine | undefined {
  const document = splitFrontMatter(text);
  if (document === null) return undefined;
  const yaml = parseDocument(document.frontMatter);
  if (yaml.errors.length > 0 || !isMap(yaml.contents)) return undefined;
  const value: unknown = yaml.get("engine");
  return isEngine(value) ? value : undefined;
}

/** The job's engine by precedence, refused when it is not enabled. */
export function resolveEngine(
  deps: Deps,
  requested: Engine | undefined,
  briefText: string,
): Result<Engine, AppError> {
  const config = deps.engineConfig.read();
  const engine = requested ?? briefEngine(briefText) ?? config.defaultEngine ?? "claude";
  if (engine === "claude") return ok(engine);
  if (!engineEnabled(config, engine)) return err({ kind: "engine_not_enabled", engine });
  return ok(engine);
}

/** A worker whose every start fails: the stand-in for an engine this process cannot build. */
function unavailable(caps: WorkerCapabilities, engine: EngineTool): Worker {
  const refusal = { kind: "unsupported" as const, message: `the ${engine} engine is not available here` };
  return {
    caps,
    preflight: async () => err(refusal),
    start: async () => err(refusal),
    parseLine: () => [],
    dispose: async () => {},
  };
}
