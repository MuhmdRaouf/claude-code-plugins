import { statSync } from "node:fs";
import { EXIT } from "@muhmdraouf/core/cli/exit.ts";
import type { Job } from "@muhmdraouf/core/domain/job.ts";
import { describe, expect, it } from "vitest";
import { e2eRepo, runZai, ZAI_REPORT } from "./harness.ts";

describe("end to end (real git, fake claude binary)", () => {
  it("brief → run --wait → fake worker edits a file in the worktree → gates pass → review → accept lands a commit on the repo's branch", async () => {
    const e2e = e2eRepo();
    const brief = e2e.brief({ edit: "src/value.txt:right\n" });

    const run = await runZai(e2e, ["run", brief, "--wait"]);
    const id = /^zai job (\S+) started: Fix the value \(glm-5\.3, edit\)$/m.exec(run.stdout)?.[1] ?? "";

    expect(run.code).toBe(EXIT.ok);
    expect(run.stdout.split("\n")[0]).toBe(`zai job ${id} started: Fix the value (glm-5.3, edit)`);
    expect(run.stdout).toContain(`zai job ${id}: verdict pass (awaiting review)`);
    expect(e2e.repo.read("src/value.txt")).toBe("wrong\n");

    const review = await runZai(e2e, ["review", id.slice(0, 9), "--diff"]);
    expect(review.stdout).toContain("+right");
    expect(review.stdout).toContain("pass  npm run --silent check");

    const accepted = await runZai(e2e, ["accept", id]);
    expect(accepted.code).toBe(EXIT.ok);
    expect(e2e.repo.read("src/value.txt")).toBe("right\n");
    expect(e2e.repo.git("log", "-1", "--format=%B").trim()).toBe(
      `Fix the value\n\n${ZAI_REPORT.summary}\n\nWorked-by: glm-5.3 via zai`,
    );
    expect(e2e.repo.git("status", "--porcelain")).toBe("");
    expect(e2e.repo.git("branch", "--list", `zai/${id}`)).toBe("");
    expect(statSync(e2e.stateRoot).mode & 0o777).toBe(0o700);
  }, 60_000);

  it("gate failure → auto-fix attempt resumes the fake session → pass", async () => {
    const e2e = e2eRepo();
    const brief = e2e.brief({ edit: "src/value.txt:still wrong\n", editOnResume: "src/value.txt:right\n" });

    const run = await runZai(e2e, ["run", brief, "--wait", "--json"]);

    expect(run.code).toBe(EXIT.ok);
    const job: Job = JSON.parse(run.stdout);
    expect(job.attempts.map((attempt) => [attempt.kind, attempt.verdict])).toEqual([
      ["initial", "gate_fail"],
      ["auto_fix", "pass"],
    ]);
    expect(job.attempts[1]?.sessionId).toBe(job.attempts[0]?.sessionId);
    expect(job.attempts[1]?.prompt).toContain("Gate failed: `npm run --silent check` (exit 1)");
  }, 60_000);

  it("return with feedback → review_fix attempt → accept", async () => {
    const e2e = e2eRepo();
    const brief = e2e.brief({
      edit: "src/value.txt:right\n",
      editOnResume: "src/extra.txt:added on review\n",
    });
    const run = await runZai(e2e, ["run", brief, "--wait", "--json"]);
    const { id } = JSON.parse(run.stdout) as Job;

    const returned = await runZai(e2e, ["return", id, "Also add src/extra.txt."]);
    expect(returned.code).toBe(EXIT.ok);
    const settled = await e2e.waitForState(id, "awaiting_review");
    expect(settled.attempts.map((attempt) => [attempt.kind, attempt.verdict])).toEqual([
      ["initial", "pass"],
      ["review_fix", "pass"],
    ]);
    expect(settled.attempts[1]?.feedback).toBe("Also add src/extra.txt.");

    expect((await runZai(e2e, ["accept", id])).code).toBe(EXIT.ok);
    expect(e2e.repo.read("src/value.txt")).toBe("right\n");
    expect(e2e.repo.read("src/extra.txt")).toBe("added on review\n");
  }, 60_000);
});
