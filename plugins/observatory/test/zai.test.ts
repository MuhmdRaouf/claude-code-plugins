import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readZaiJobs } from "../src/ingest/zai.ts";
import { makeEnv, writeText } from "./helpers.ts";

/** A job dir under the temp zai state: optional job.json plus any number of attempt files. */
function writeJob(root: string, id: string, jobJson: string | null, attempts: string[] = []): string {
  const dir = join(root, "jobs", id);
  if (jobJson === null) {
    mkdirSync(dir, { recursive: true });
  } else {
    writeText(join(dir, "job.json"), jobJson);
  }
  for (const name of attempts) {
    writeText(join(dir, name), "");
  }
  return dir;
}

describe("readZaiJobs", () => {
  it("returns nothing when the jobs root is missing", () => {
    const { env } = makeEnv();
    expect(readZaiJobs(env)).toEqual([]);
  });

  it("skips dirs without a readable job.json and keeps the rest", () => {
    const { env, zai } = makeEnv();
    writeJob(zai, "empty-dir", null);
    writeJob(zai, "junk", "{oops");
    writeJob(zai, "array", "[1]");
    writeJob(zai, "good", JSON.stringify({ id: "good" }));
    const jobs = readZaiJobs(env);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe("good");
  });

  it("maps a full job: zai-qualified session and model, numeric attempt order", () => {
    const { env, zai } = makeEnv();
    const dir = writeJob(
      zai,
      "j1",
      JSON.stringify({
        id: "j1",
        brief: { title: "Fix the flaky test", model: "glm-5.3" },
        state: "running",
        updatedAt: "2030-01-01T00:00:00Z",
      }),
      ["attempt-2.jsonl", "attempt-10.jsonl", "attempt-1.jsonl", "notes.txt"],
    );
    expect(readZaiJobs(env)).toEqual([
      {
        id: "j1",
        sessionId: "zai:j1",
        title: "Fix the flaky test",
        state: "running",
        live: true,
        model: "zai:glm-5.3",
        updatedAt: Date.parse("2030-01-01T00:00:00Z"), // newer than any attempt mtime, so it stands
        dir,
        attemptFiles: [
          join(dir, "attempt-1.jsonl"),
          join(dir, "attempt-2.jsonl"),
          join(dir, "attempt-10.jsonl"),
        ],
      },
    ]);
  });

  it("falls back to the dir name and nulls out unusable fields", () => {
    const { env, zai } = makeEnv();
    writeJob(zai, "raw-id", JSON.stringify({ state: 42, brief: "not-an-object", updatedAt: "nope" }));
    expect(readZaiJobs(env)).toEqual([
      {
        id: "raw-id",
        sessionId: "zai:raw-id",
        title: null,
        state: null,
        live: true, // state null means unknown, not finished
        model: null,
        updatedAt: null,
        dir: join(zai, "jobs", "raw-id"),
        attemptFiles: [],
      },
    ]);
  });

  it("treats only the terminal states as finished", () => {
    const { env, zai } = makeEnv();
    const cases: Array<[string, string | null, boolean]> = [
      ["t-accepted", "accepted", false],
      ["t-discarded", "discarded", false],
      ["t-failed", "failed", false],
      ["t-running", "running", true],
      ["t-none", null, true],
    ];
    for (const [dirName, state] of cases) {
      const job: Record<string, unknown> = {};
      if (state !== null) job.state = state;
      writeJob(zai, dirName, JSON.stringify(job));
    }
    const jobs = readZaiJobs(env);
    for (const [dirName, , live] of cases) {
      expect(jobs.find((job) => job.id === dirName)?.live).toBe(live);
    }
  });

  it("takes the freshest attempt mtime over a stale updatedAt, ignoring broken symlinks", () => {
    const { env, zai } = makeEnv();
    const dir = writeJob(zai, "live", JSON.stringify({ updatedAt: "2020-01-01T00:00:00Z" }), [
      "attempt-1.jsonl",
    ]);
    symlinkSync(join(dir, "attempt-none.jsonl"), join(dir, "attempt-9.jsonl")); // dangling on purpose
    const job = readZaiJobs(env)[0];
    expect(job?.attemptFiles).toEqual([join(dir, "attempt-1.jsonl"), join(dir, "attempt-9.jsonl")]);
    expect(job?.updatedAt).not.toBe(Date.parse("2020-01-01T00:00:00Z"));
    expect(job?.updatedAt ?? 0).toBeGreaterThan(Date.now() - 60_000); // the attempt we just touched
  });

  it("orders jobs newest-first, updatedAt-less jobs last", () => {
    const { env, zai } = makeEnv();
    writeJob(zai, "b", JSON.stringify({ updatedAt: "2030-01-02T00:00:00Z" }));
    writeJob(zai, "c", JSON.stringify({}));
    writeJob(zai, "a", JSON.stringify({ updatedAt: "2030-01-03T00:00:00Z" }));
    expect(readZaiJobs(env).map((job) => job.id)).toEqual(["a", "b", "c"]);
  });
});
