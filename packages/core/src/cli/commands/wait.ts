import { followJob } from "../../app/follow.ts";
import type { Job } from "../../domain/job.ts";
import { renderSummary, renderWaitLine, renderWaitTotals } from "../../render/index.ts";
import type { Command, Invocation } from "../command.ts";
import { EXIT, type ExitCode } from "../exit.ts";
import { untilInterrupted } from "../interrupt.ts";

export const waitCommand: Command = {
  name: "wait",
  synopsis: ["wait <id> [<id>…] [--json]"],
  options: {},
  async run(call) {
    const [id, ...more] = call.positionals;
    if (id === undefined) return call.usage("wait needs a job id");
    return more.length === 0 ? followAndReport(call, id) : followAll(call, [id, ...more]);
  },
};

/**
 * Follows a job a detached driver works until it lands, then prints its summary (exit 0 on pass, 3 otherwise).
 * SIGINT/SIGTERM only end the follow (exit 130); a job no live driver will finish exits 6 (not ready: it needs
 * stop or discard). The job itself is never touched.
 */
export async function followAndReport(call: Invocation, id: string): Promise<ExitCode> {
  const followed = await untilInterrupted((signal) => followJob(call.deps, id, signal));
  if (!followed.ok) return call.fail(followed.error);
  const { kind, job } = followed.value;
  const { name, slash } = call.deps.provider;
  if (call.flag("json")) call.json(job);
  switch (kind) {
    case "landed":
      if (!call.flag("json")) call.deps.out.line(renderSummary(call.deps.provider, job));
      return job.attempts.at(-1)?.verdict === "pass" ? EXIT.ok : EXIT.notPass;
    case "stale":
      call.deps.out.error(
        `${name}: job ${job.id} is ${job.state} but has no live driver; ${slash}board stops it (it moves to review), ${slash}review ${job.id} then discards it.`,
      );
      return EXIT.notReady;
    case "detached":
      call.deps.out.error(
        `${name} job ${job.id} keeps running detached: ${slash}board shows it and can stop it, ${slash}review ${job.id} once it awaits review.`,
      );
      return EXIT.interrupted;
  }
}

/**
 * Follows many jobs at once (one `wait` beats one watcher per job): each prints its compact line as it lands, then one
 * totals line. Exit 0 only when every landed verdict is pass; an interrupt detaches them all (exit 130, no totals).
 */
export async function followAll(call: Invocation, ids: readonly string[]): Promise<ExitCode> {
  const followed = await untilInterrupted((signal) =>
    Promise.all(
      ids.map(async (id) => {
        const one = await followJob(call.deps, id, signal);
        if (one.ok && one.value.kind !== "detached" && !call.flag("json")) {
          call.deps.out.line(renderWaitLine(call.deps.provider, one.value.job, one.value.kind === "landed"));
        }
        return one;
      }),
    ),
  );
  const jobs: Job[] = [];
  const { name, slash } = call.deps.provider;
  for (const one of followed) {
    if (!one.ok) return call.fail(one.error);
    const { kind, job } = one.value;
    if (kind === "detached") {
      call.deps.out.error(
        `${name} job ${job.id} keeps running detached: ${slash}board shows it and can stop it, ${slash}review ${job.id} once it awaits review.`,
      );
      return EXIT.interrupted;
    }
    if (kind === "stale") {
      call.deps.out.error(
        `${name}: job ${job.id} is ${job.state} but has no live driver; ${slash}board stops it (it moves to review), ${slash}review ${job.id} then discards it.`,
      );
    }
    jobs.push(job);
  }
  if (call.flag("json")) call.json(jobs);
  else call.deps.out.line(renderWaitTotals(call.deps.provider, jobs));
  return jobs.every((job) => job.attempts.at(-1)?.verdict === "pass") ? EXIT.ok : EXIT.notPass;
}
