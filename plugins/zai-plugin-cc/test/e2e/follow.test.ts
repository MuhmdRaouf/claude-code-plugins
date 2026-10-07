import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "@muhmdraouf/core/cli/exit.ts";
import { isPidAlive } from "@muhmdraouf/core/testing";
import { describe, expect, it } from "vitest";
import { type E2E, e2eRepo, runZai, startZai } from "./harness.ts";

/** A worker that sleeps until the 2 s attempt timeout, with no retries: the job lands with verdict timeout. */
function sleepingBrief(e2e: E2E): string {
  return e2e.brief({
    edit: "src/value.txt:right\n",
    scenario: "sleep",
    front: ["timeout: 2s", "retries: { fix: 0, infra: 0 }"],
  });
}

function startedId(line: string): string {
  const id = /^zai job (\S+) started: Fix the value \(glm-5\.3, edit\)$/.exec(line)?.[1];
  if (id === undefined) throw new Error(`no started line: ${JSON.stringify(line)}`);
  return id;
}

function driverAlive(e2e: E2E, id: string): boolean {
  try {
    return isPidAlive(Number(readFileSync(join(e2e.stateRoot, "jobs", id, "driver.lock"), "utf8").trim()));
  } catch {
    return false;
  }
}

describe("run --wait follows a detached driver (real processes, fake claude)", () => {
  it("SIGKILL on the follower leaves the job running; wait <id> re-attaches and prints the summary", async () => {
    const e2e = e2eRepo();
    const run = startZai(e2e, ["run", sleepingBrief(e2e), "--wait"]);
    const id = startedId(await run.firstLine);
    await e2e.waitForState(id, "running");

    run.child.kill("SIGKILL");
    const killed = await run.done;

    expect(killed.signal).toBe("SIGKILL");
    expect(driverAlive(e2e, id)).toBe(true);

    const waited = await runZai(e2e, ["wait", id]);

    expect(waited.stderr).toBe("");
    expect(waited.code).toBe(EXIT.notPass);
    expect(waited.stdout).toMatch(new RegExp(`^zai job ${id}: verdict timeout \\(awaiting review\\)\n`));
    expect(waited.stdout).toContain(
      `Next: the worker never finished (timed out): nothing to accept. Fix the cause, then /zai:review ${id} to return it to try again, or discard it.`,
    );
    expect((await runZai(e2e, ["wait", id])).stdout).toBe(waited.stdout);
  }, 60_000);

  it("SIGTERM on the follower only detaches: one line, exit 130, and the job still lands in review", async () => {
    const e2e = e2eRepo();
    const run = startZai(e2e, ["run", sleepingBrief(e2e), "--wait"]);
    const id = startedId(await run.firstLine);
    await e2e.waitForState(id, "running");

    run.child.kill("SIGTERM");
    const detached = await run.done;

    expect(detached.code).toBe(EXIT.interrupted);
    expect(detached.stderr).toBe(
      `zai job ${id} keeps running detached: /zai:board shows it and can stop it, /zai:review ${id} once it awaits review.\n`,
    );
    const landed = await e2e.waitForState(id, "awaiting_review");
    expect(landed.attempts.map((attempt) => attempt.verdict)).toEqual(["timeout"]);
  }, 60_000);
});
