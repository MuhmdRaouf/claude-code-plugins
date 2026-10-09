import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EXIT } from "@muhmdraouf/core/cli/exit.ts";
import { descendants, isPidAlive, parentTable } from "@muhmdraouf/core/testing";
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
  const id = /^zai job (\S+) started: /.exec(line)?.[1];
  if (id === undefined) throw new Error(`no started line: ${JSON.stringify(line)}`);
  return id;
}

function driverPid(e2e: E2E, id: string): number {
  return Number(readFileSync(join(e2e.stateRoot, "jobs", id, "driver.lock"), "utf8").trim());
}

function signalAll(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** What Claude Code does to a background Bash shell it cleans up: SIGTERM the whole tree, SIGKILL it ~300 ms later. */
async function treeKill(root: number): Promise<readonly number[]> {
  const tree = [root, ...descendants(root)];
  signalAll(tree, "SIGTERM");
  await delay(300);
  signalAll(tree, "SIGKILL");
  return tree;
}

describe("run --wait survives a tree-kill of its caller (real processes, fake claude)", () => {
  it("SIGTERM then SIGKILL of the follower's whole process tree leaves the driver; the job lands in review", async () => {
    const e2e = e2eRepo();
    const run = startZai(e2e, ["run", sleepingBrief(e2e), "--wait"]);
    const id = startedId(await run.firstLine);
    await e2e.waitForState(id, "running");

    const driver = driverPid(e2e, id);
    const killed = await treeKill(run.child.pid ?? -1);
    await run.done;

    expect(killed).not.toContain(driver);
    const waited = await runZai(e2e, ["wait", id]);
    expect(waited.stderr).toBe("");
    expect(waited.code).toBe(EXIT.notPass);
    expect(waited.stdout).toMatch(new RegExp(`^zai job ${id}: verdict timeout \\(awaiting review\\)\n`));
  }, 60_000);

  it("the driver is an orphan: not a descendant of the follower that started it", async () => {
    const e2e = e2eRepo();
    const run = startZai(e2e, ["run", sleepingBrief(e2e), "--wait"]);
    const id = startedId(await run.firstLine);
    await e2e.waitForState(id, "running");

    const table = parentTable();
    const follower = run.child.pid ?? -1;
    const driver = driverPid(e2e, id);

    expect(isPidAlive(driver)).toBe(true);
    expect(table.get(driver)).not.toBe(follower);
    expect(descendants(follower, table)).not.toContain(driver);
    expect(descendants(process.pid, table)).not.toContain(driver);
    run.child.kill("SIGKILL");
    await run.done;
    // Let the driver reap its worker (own group): ending mid-run would leave it to the harness's driver-group SIGKILL.
    await e2e.waitForState(id, "awaiting_review");
  }, 60_000);
});
