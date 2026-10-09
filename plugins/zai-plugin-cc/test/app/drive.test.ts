import { drive } from "@muhmdraouf/core/app/drive.ts";
import type { Brief } from "@muhmdraouf/core/domain/brief.ts";
import type { Attempt, Job } from "@muhmdraouf/core/domain/job.ts";
import { autoFixPrompt, DEFAULT_LIMITS, selfContainedPrompt } from "@muhmdraouf/core/domain/prompt.ts";
import { aBrief, aChangeSet, aJob } from "@muhmdraouf/core/testing";
import { describe, expect, it } from "vitest";
import { ZAI_PROVIDER } from "../../src/provider.ts";
import { completes, type Fakes, fakeDeps, type WorkerScript } from "../support/fakes.ts";

// core's drive suite runs on the reference worker; the one case that hangs on the claude worker's own signal (what
// Claude Code prints for an unknown session) runs here, on the claude dialect.

const ID = "261006-drive1";
const GATED: Partial<Brief> = { gates: [{ run: "npm test", timeoutMs: 60_000 }] };

/** A queued job in the fake store, its artifacts dir under the fake state root. */
function queued(fakes: Fakes, brief: Partial<Brief> = {}): Job {
  const paths = fakes.store.paths(ID);
  return fakes.store.put(
    aJob({
      id: ID,
      brief: aBrief(brief),
      workspace: {
        repoRoot: "/repo",
        baseSha: "b".repeat(40),
        worktree: paths.worktree,
        branch: `zai/${ID}`,
        artifactsDir: paths.artifacts,
      },
    }),
  );
}

function setup(scripts?: WorkerScript[]): Fakes {
  const fakes = fakeDeps(scripts);
  fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
  return fakes;
}

function stored(fakes: Fakes): Job {
  const job = fakes.store.jobs.get(ID);
  if (job === undefined) throw new Error("job not stored");
  return job;
}

function attempt(fakes: Fakes, n: number): Attempt {
  const found = stored(fakes).attempts[n - 1];
  if (found === undefined) throw new Error(`no attempt ${n}`);
  return found;
}

describe("drive on the claude worker", () => {
  it("resume failure (worker reports no such session) → falls back to selfContainedPrompt in a new session", async () => {
    const noSession: WorkerScript = {
      bare: true,
      exit: {
        code: 1,
        stderrTail: "No conversation found with session ID: 00000000-0000-4000-8000-000000000001",
      },
    };
    const fakes = setup([completes(), noSession, completes()]);
    fakes.gates.failOnce("npm test");
    const job = queued(fakes, GATED);

    await drive(fakes.deps, ID);

    const [first, resumed, fresh] = fakes.worker.specs;
    const followUp = autoFixPrompt(job.brief, attempt(fakes, 1), DEFAULT_LIMITS);
    expect(resumed?.session).toEqual({ kind: "resume", key: first?.session.key });
    expect(fresh?.session.kind).toBe("new");
    expect(fresh?.session.key).not.toBe(first?.session.key);
    expect(fresh?.prompt).toBe(
      selfContainedPrompt(job.brief, [attempt(fakes, 1)], followUp, job.workspace.artifactsDir, ZAI_PROVIDER),
    );
    expect(stored(fakes).attempts).toHaveLength(2);
    expect(attempt(fakes, 2)).toMatchObject({
      kind: "auto_fix",
      sessionId: fresh?.session.key,
      prompt: fresh?.prompt,
      verdict: "pass",
    });
  });
});
