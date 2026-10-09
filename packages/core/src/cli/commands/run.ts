import { resolve } from "node:path";
import { drive } from "../../app/drive.ts";
import { submit } from "../../app/submit.ts";
import type { BriefOverrides } from "../../app/submit-overrides.ts";
import { ENGINES, isEngine } from "../../domain/engine.ts";
import type { Job } from "../../domain/job.ts";
import { err, ok, type Result } from "../../domain/result.ts";
import { renderStarted, renderSummary } from "../../render/index.ts";
import type { Command, Invocation } from "../command.ts";
import { EXIT, type ExitCode } from "../exit.ts";
import { untilInterrupted } from "../interrupt.ts";
import { readBrief, readStdin } from "../read.ts";
import { modeOption } from "./mode.ts";
import { followAndReport } from "./wait.ts";

export const runCommand: Command = {
  name: "run",
  synopsis: ["run <brief.md|-> [--flash] [--mode edit|exec|readonly] [--wait|--bg] [--json]"],
  options: {
    flash: { type: "boolean" },
    mode: { type: "string" },
    wait: { type: "boolean" },
    bg: { type: "boolean" },
    engine: { type: "string" },
  },
  async run(call) {
    const [path] = call.positionals;
    if (path === undefined) return call.usage("run needs a brief path (- reads stdin)");
    if (call.flag("wait") && call.flag("bg")) return call.usage("--wait and --bg exclude each other");
    const overrides = overridesOf(call);
    if (!overrides.ok) return call.usage(overrides.error);
    const text = await readBrief(path === "-" ? path : resolve(call.cwd, path), readStdin);
    if (!text.ok) return call.fail(text.error);
    const job = await submit(call.deps, {
      text: text.value,
      ...(path === "-" ? {} : { sourcePath: resolve(call.cwd, path) }),
      cwd: call.cwd,
      overrides: overrides.value,
      defaultPriority: "high",
    });
    if (!job.ok) return call.fail(job.error);
    if (!call.flag("json")) call.deps.out.line(renderStarted(call.deps.provider, job.value));
    if (!call.flag("wait")) return detach(call, job.value);
    call.deps.process.spawnDriver(job.value.id);
    return followAndReport(call, job.value.id);
  },
};

/** --flash, --mode and --engine as brief overrides, or the usage error. */
function overridesOf(call: Invocation): Result<BriefOverrides, string> {
  const mode = modeOption(call);
  if (!mode.ok) return err(mode.error);
  const engine = call.text("engine");
  if (engine !== undefined && !isEngine(engine)) return err(`--engine must be one of ${ENGINES.join(", ")}`);
  return ok({
    ...(call.flag("flash") ? { model: "flash" } : {}),
    ...(mode.value === undefined ? {} : { mode: mode.value }),
    ...(engine === undefined ? {} : { engine }),
  });
}

function detach(call: Invocation, job: Job): ExitCode {
  call.deps.process.spawnDriver(job.id);
  if (call.flag("json")) call.json(job);
  else
    call.deps.out.line(
      `Running detached: ${call.deps.provider.slash}board shows it, ${call.deps.provider.slash}review ${job.id} once it awaits review.`,
    );
  return EXIT.ok;
}

export const driveCommand: Command = {
  name: "drive",
  synopsis: ["drive <id>"],
  options: {},
  hidden: true,
  async run(call) {
    const [id] = call.positionals;
    if (id === undefined) return call.usage("drive needs a job id");
    const driven = await untilInterrupted((signal) => drive(call.deps, id, signal));
    if (!driven.ok) return call.fail(driven.error);
    call.deps.out.line(renderSummary(call.deps.provider, driven.value));
    return EXIT.ok;
  },
};
