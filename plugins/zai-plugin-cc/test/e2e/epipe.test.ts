import { describe, expect, it } from "vitest";
import { e2eRepo, startZai } from "./harness.ts";

describe("a closed stdout (`zai run --wait | head -1`)", () => {
  it("ends the CLI quietly once the pipe's reader goes away: exit 0, no EPIPE stack trace", async () => {
    const e2e = e2eRepo();
    const run = startZai(e2e, ["run", e2e.brief({ edit: "right" }), "--wait"]);

    expect(await run.firstLine).toMatch(/^zai job \S+ started: Fix the value \(glm-5\.3, edit\)$/);
    // The reader closes after the first line; the summary (written once the job lands, one
    // 2 s poll later at the earliest) then hits a closed pipe.
    run.child.stdout?.destroy();

    const done = await run.done;
    expect(done.code).toBe(0);
    expect(done.stderr).toBe("");
  }, 60_000);
});
