import {
  aBrief,
  aChangeSet,
  aJob,
  EVENT_FIXTURES,
  type Fakes,
  fakeDeps,
  type WorkerDialect,
  type WorkerScript,
} from "@muhmdraouf/core/testing";
import { describe, expect, it } from "vitest";
import { drive } from "../../src/app/drive.ts";
import type { WorkerEvent } from "../../src/domain/worker-events.ts";

/** A worker that is not claude and not omp: a plain-text wire, one verb per line. Anything that folds into WorkerEvents
 *  is a worker as far as the driver is concerned — this dialect exists to prove the limiter hears it too. */
const PLAIN: WorkerDialect = {
  caps: {
    name: "opencode",
    sessionKey: "caller",
    nativeSchema: false,
    budget: false,
    efforts: ["none"],
    briefNotes: {
      effort: "not supported",
      addDirs: "not supported",
      budgetUsd: "not supported",
      readonly: "not supported",
    },
  },
  parseLine(text: string): readonly WorkerEvent[] {
    const [verb = "", ...words] = text.split(" ");
    const rest = words.join(" ");
    if (verb === "SESSION") return [{ type: "init", sessionId: rest, model: "plain-1" }];
    if (verb === "THROTTLED")
      return [{ type: "api_retry", attempt: 1, maxRetries: 10, status: Number(rest) }];
    if (verb === "FAILED")
      return [
        {
          type: "result",
          isError: true,
          text: rest.slice(rest.indexOf(" ") + 1),
          structuredOutput: null,
          turns: 1,
          durationMs: 10,
          costUsd: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          apiErrorStatus: Number(words[0]),
        },
      ];
    if (verb === "DONE")
      return [
        {
          type: "result",
          isError: false,
          text: "done",
          structuredOutput: JSON.parse(rest),
          turns: 1,
          durationMs: 10,
          costUsd: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          apiErrorStatus: null,
        },
      ];
    return [];
  },
  init: (sessionKey: string): string => `SESSION ${sessionKey}`,
  sessionMissing: () => false,
  fixtures: EVENT_FIXTURES,
};

/** A queued job over the plain worker. */
function queued(fakes: Fakes, id: string): void {
  const paths = fakes.store.paths(id);
  fakes.store.put(
    aJob({
      id,
      brief: aBrief({ retries: { fix: 0, infra: 0 } }),
      workspace: {
        repoRoot: "/repo",
        baseSha: "b".repeat(40),
        worktree: paths.worktree,
        branch: `zai/${id}`,
        artifactsDir: paths.artifacts,
      },
    }),
  );
}

describe("drive with a worker that is not claude", () => {
  it("rate limits on any wire: three 429 retries and one terminal 429 reach the limiter, whatever the worker", async () => {
    const quorum: WorkerScript = {
      lines: [
        "THROTTLED 429",
        "THROTTLED 529",
        "THROTTLED 429",
        `DONE ${JSON.stringify({ summary: "done" })}`,
      ],
    };
    const terminal: WorkerScript = { lines: ["THROTTLED 429", "FAILED 429 quota exhausted"] };
    const fakes = fakeDeps([quorum, terminal], {}, { dialect: PLAIN });
    fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
    queued(fakes, "261006-throt1");
    queued(fakes, "261006-throt2");

    await drive(fakes.deps, "261006-throt1");
    await drive(fakes.deps, "261006-throt2");

    // The quorum path: both 429 retries of the first run and the one of the second reach the limiter — the 529 does not.
    // The terminal call reports too, so it is four in total.
    expect(fakes.limiter.rateLimitedAt).toHaveLength(4);
    // The terminal path: the 429 that ended the second attempt is flagged, so the cap drops without waiting for a quorum.
    expect(fakes.limiter.endedAttempts).toHaveLength(1);
  });
});
