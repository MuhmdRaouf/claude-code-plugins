import { accept, discard, returnForFix, stop } from "../../app/decide.ts";
import type { AppError } from "../../app/errors.ts";
import type { Job, JobState } from "../../domain/job.ts";
import type { Provider } from "../../domain/provider.ts";
import { conflictStep } from "../../render/next.ts";
import type { Command, Invocation } from "../command.ts";
import { describeError, exitFor } from "../errors.ts";
import { EXIT, type ExitCode } from "../exit.ts";
import { repoOf } from "../scope.ts";

const SHORT_SHA = 12;
const STOPPABLE: ReadonlySet<JobState> = new Set<JobState>(["queued", "running", "verifying"]);

export const acceptCommand: Command = {
  name: "accept",
  synopsis: ["accept <id> [--no-commit] [--force] [--no-verify] [--json]"],
  options: { "no-commit": { type: "boolean" }, force: { type: "boolean" }, "no-verify": { type: "boolean" } },
  async run(call) {
    const [id] = call.positionals;
    if (id === undefined) return call.usage("accept needs a job id");
    const accepted = await accept(call.deps, id, {
      mode: call.flag("no-commit") ? "no_commit" : "commit",
      force: call.flag("force"),
      verify: !call.flag("no-verify"),
    });
    if (!accepted.ok) return acceptFailed(call, accepted.error);
    if (call.flag("json")) call.json(accepted.value);
    else call.deps.out.line(acceptedLine(call.deps.provider, accepted.value));
    return EXIT.ok;
  },
};

function acceptedLine(provider: Provider, job: Job): string {
  const head = `${provider.name} job ${job.id} accepted`;
  if (job.brief.mode !== "edit") return `${head} (${job.brief.mode}: nothing to merge)`;
  const commit = job.decision?.kind === "accepted" ? job.decision.commit : undefined;
  return commit === undefined
    ? `${head}: applied to the working tree of ${job.workspace.repoRoot}, not committed`
    : `${head}: commit ${commit.slice(0, SHORT_SHA)} on the current branch of ${job.workspace.repoRoot}`;
}

/** Git failures name the way forward: nothing was applied, so the job still awaits review. */
function acceptFailed(call: Invocation, error: AppError): ExitCode {
  const { out, provider } = call.deps;
  const message = `${provider.name}: ${describeError(provider, error)}`;
  if (error.kind === "land_conflict") {
    out.error(`${message}: ${conflictStep(provider)}`);
  } else if (error.kind === "land_verify_failed") {
    out.error(
      `${message}: nothing was applied. ${provider.slash}review returns the job with the failing output as feedback.`,
    );
    for (const line of error.tail.split("\n")) out.error(`  ${line}`);
  } else if (error.kind !== "git") {
    out.error(message);
  } else if (error.error.kind === "conflict") {
    out.error(`${message}: ${conflictStep(provider)}`);
  } else if (error.error.kind === "dirty") {
    out.error(`${message}: nothing was applied. Commit or stash them, then accept again.`);
  } else if (error.error.kind === "git_failed" && error.error.command.startsWith("git commit")) {
    out.error(message);
    out.error(
      `${provider.name}: the job still awaits review. Fix what the commit hook reports, then accept it again.`,
    );
  } else {
    out.error(message);
  }
  return exitFor(error);
}

export const returnCommand: Command = {
  name: "return",
  synopsis: ["return <id> <feedback…> [--json]"],
  options: {},
  async run(call) {
    const [id, ...words] = call.positionals;
    if (id === undefined) return call.usage("return needs a job id");
    if (words.join("").trim() === "") return call.usage("return needs feedback for the worker");
    const returned = await returnForFix(call.deps, id, words.join(" "));
    if (!returned.ok) return call.fail(returned.error);
    const job = returned.value;
    const { name, slash } = call.deps.provider;
    call.deps.process.spawnDriver(job.id);
    if (call.flag("json")) call.json(job);
    else
      call.deps.out.line(
        `${name} job ${job.id} returned with feedback: attempt ${job.attempts.length} runs detached. ${slash}review ${job.id} once it awaits review again.`,
      );
    return EXIT.ok;
  },
};

export const discardCommand: Command = {
  name: "discard",
  synopsis: ["discard <id> [--reason <text>] [--json]"],
  options: { reason: { type: "string" } },
  async run(call) {
    const [id] = call.positionals;
    if (id === undefined) return call.usage("discard needs a job id");
    const reason = call.text("reason")?.trim();
    const discarded = await discard(call.deps, id, reason === "" ? undefined : reason);
    if (!discarded.ok) return call.fail(discarded.error);
    if (call.flag("json")) call.json(discarded.value);
    else
      call.deps.out.line(
        `${call.deps.provider.name} job ${discarded.value.id} discarded${reason ? `: ${reason}` : ""}`,
      );
    return EXIT.ok;
  },
};

export const stopCommand: Command = {
  name: "stop",
  synopsis: ["stop <id|--all> [--json]"],
  options: { all: { type: "boolean" } },
  async run(call) {
    const ids = call.flag("all") ? await stoppable(call) : call.positionals;
    if (ids.length === 0 && !call.flag("all")) return call.usage("stop needs a job id or --all");
    const { stopped, code } = await stopAll(call, ids);
    if (call.flag("json")) call.json(stopped);
    else if (ids.length === 0)
      call.deps.out.line(`${call.deps.provider.name}: no queued or running job to stop`);
    else for (const job of stopped) call.deps.out.line(stoppedLine(call.deps.provider, job));
    return code;
  },
};

/** Stops each job in turn; a failure is reported and the rest still stop. The first failure sets the exit code. */
async function stopAll(
  call: Invocation,
  ids: readonly string[],
): Promise<{ readonly stopped: readonly Job[]; readonly code: ExitCode }> {
  const stopped: Job[] = [];
  let code: ExitCode = EXIT.ok;
  for (const id of ids) {
    const result = await stop(call.deps, id);
    if (result.ok) {
      stopped.push(result.value);
      continue;
    }
    const failed = call.fail(result.error);
    if (code === EXIT.ok) code = failed;
  }
  return { stopped, code };
}

async function stoppable(call: Invocation): Promise<readonly string[]> {
  const repoRoot = await repoOf(call.deps, call.cwd);
  const jobs = await call.deps.store.list(repoRoot === undefined ? undefined : { repoRoot });
  return jobs.filter((job) => STOPPABLE.has(job.state)).map((job) => job.id);
}

function stoppedLine({ name }: Provider, job: Job): string {
  return job.state === "awaiting_review"
    ? `${name} job ${job.id} stopped: awaiting review`
    : `${name} job ${job.id}: stopping; it will wait for your review as "stopped"`;
}
