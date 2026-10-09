import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attemptTranscript,
  JOB_PLUGINS,
  type JobPlugin,
  jobClaudeHome,
  readJobs,
  ZAI_JOB_UPSTREAM,
} from "../src/ingest/jobs.ts";
import { jsonl, makeEnv, writeText } from "./helpers.ts";

/** A provider's state dir under the test home. */
function stateRoot(home: string, plugin: JobPlugin): string {
  return join(home, plugin);
}

/** A job dir under a provider's state dir: optional job.json plus any number of attempt files. */
function writeJob(stateDir: string, id: string, jobJson: string | null, attempts: string[] = []): string {
  const dir = join(stateDir, "jobs", id);
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

/** An env whose every provider state dir points into one throwaway home. */
function makeJobEnv(): { env: NodeJS.ProcessEnv; home: string } {
  const { env, home } = makeEnv();
  for (const plugin of JOB_PLUGINS) env[`${plugin.toUpperCase()}_STATE_DIR`] = join(home, plugin);
  return { env, home };
}

describe("plugin state dirs", () => {
  it("reads each provider's jobs from its own state dir", () => {
    const { env, home } = makeJobEnv();
    writeJob(stateRoot(home, "zai"), "z1", JSON.stringify({}));
    writeJob(stateRoot(home, "kimi"), "k1", JSON.stringify({}));
    writeJob(stateRoot(home, "deepseek"), "d1", JSON.stringify({}));
    writeJob(stateRoot(home, "minimax"), "m1", JSON.stringify({}));
    writeJob(stateRoot(home, "qwen"), "q1", JSON.stringify({}));
    expect(readJobs(env).map((job) => job.sessionId)).toEqual([
      "zai:z1",
      "kimi:k1",
      "deepseek:d1",
      "minimax:m1",
      "qwen:q1",
    ]);
  });

  it("honours a per-provider <NAME>_STATE_DIR override", () => {
    const { env, home } = makeJobEnv();
    writeJob(stateRoot(home, "kimi"), "elsewhere", JSON.stringify({}));
    env.KIMI_STATE_DIR = join(home, "kimi-override");
    writeJob(join(home, "kimi-override"), "overridden", JSON.stringify({}));
    expect(readJobs(env).map((job) => job.id)).toEqual(["overridden"]);
  });

  it("falls back to ~/.agents/<name> without an override", () => {
    const { env, home } = makeJobEnv();
    for (const plugin of JOB_PLUGINS) delete env[`${plugin.toUpperCase()}_STATE_DIR`];
    writeJob(join(home, ".agents", "deepseek"), "d1", JSON.stringify({}));
    expect(readJobs(env).map((job) => job.id)).toEqual(["d1"]);
    expect(jobClaudeHome(env, "qwen")).toBe(join(home, ".agents", "qwen", "claude-home"));
  });

  it("silently skips providers with no jobs dir", () => {
    const { env, home } = makeJobEnv();
    writeJob(stateRoot(home, "minimax"), "m1", JSON.stringify({}));
    expect(readJobs(env).map((job) => job.sessionId)).toEqual(["minimax:m1"]);
  });
});

describe("readJobs", () => {
  it("returns nothing when no provider has a jobs dir", () => {
    const { env } = makeJobEnv();
    expect(readJobs(env)).toEqual([]);
  });

  it("skips dirs without a readable job.json and keeps the rest", () => {
    const { env, home } = makeJobEnv();
    writeJob(stateRoot(home, "zai"), "empty-dir", null);
    writeJob(stateRoot(home, "zai"), "junk", "{oops");
    writeJob(stateRoot(home, "zai"), "array", "[1]");
    writeJob(stateRoot(home, "zai"), "good", JSON.stringify({ id: "good" }));
    const jobs = readJobs(env);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe("good");
  });

  it("maps a full job: plugin-qualified session and model, numeric attempt order", () => {
    const { env, home } = makeJobEnv();
    const dir = writeJob(
      stateRoot(home, "kimi"),
      "j1",
      JSON.stringify({
        id: "j1",
        brief: { title: "Fix the flaky test", model: "kimi-k2.5" },
        state: "running",
        updatedAt: "2030-01-01T00:00:00Z",
      }),
      ["attempt-2.jsonl", "attempt-10.jsonl", "attempt-1.jsonl", "notes.txt"],
    );
    expect(readJobs(env)).toEqual([
      {
        id: "j1",
        plugin: "kimi",
        sessionId: "kimi:j1",
        title: "Fix the flaky test",
        state: "running",
        live: true,
        model: "kimi:kimi-k2.5",
        updatedAt: Date.parse("2030-01-01T00:00:00Z"), // newer than any attempt mtime, so it stands
        dir,
        attempts: [
          { file: join(dir, "attempt-1.jsonl"), n: 1, sessionId: null },
          { file: join(dir, "attempt-2.jsonl"), n: 2, sessionId: null },
          { file: join(dir, "attempt-10.jsonl"), n: 10, sessionId: null },
        ],
        upstream: "",
        repoRoot: null,
        branch: null,
        parentSessionId: null,
      },
    ]);
  });

  it("reads workspace, origin and attempt session ids, and survives a missing origin", () => {
    const { env, home } = makeJobEnv();
    writeJob(
      stateRoot(home, "zai"),
      "full",
      JSON.stringify({
        workspace: { repoRoot: "/w/main", branch: "zai/full" },
        origin: { sessionId: "018c3a2b-7c8d-7cde-9f01-2a3b4c5d6e7f" },
        attempts: [{ n: 1, sessionId: "att-1" }, { n: 2, sessionId: "att-2" }, { n: 3 }],
      }),
      ["attempt-1.jsonl", "attempt-2.jsonl", "attempt-3.jsonl"],
    );
    writeJob(stateRoot(home, "zai"), "bare", JSON.stringify({ brief: "not-an-object", state: 42 }));
    const [full, bare] = readJobs(env);
    expect(full).toMatchObject({
      sessionId: "zai:full",
      repoRoot: "/w/main",
      branch: "zai/full",
      parentSessionId: "018c3a2b-7c8d-7cde-9f01-2a3b4c5d6e7f",
    });
    expect(full?.attempts.map((attempt) => attempt.sessionId)).toEqual(["att-1", "att-2", null]);
    expect(bare).toMatchObject({
      repoRoot: null,
      branch: null,
      parentSessionId: null,
      state: null,
      live: false, // no state field, no running job
    });
  });

  it("keeps zai's own upstream and takes the others from what radar knows", () => {
    const { env, home } = makeJobEnv();
    writeJob(stateRoot(home, "zai"), "z1", JSON.stringify({}));
    writeJob(stateRoot(home, "kimi"), "k1", JSON.stringify({}));
    writeJob(stateRoot(home, "qwen"), "q1", JSON.stringify({}));
    const jobs = readJobs(env, (plugin) => (plugin === "kimi" ? "https://api.moonshot.ai/anthropic" : ""));
    expect(jobs.find((job) => job.id === "z1")?.upstream).toBe(ZAI_JOB_UPSTREAM);
    expect(jobs.find((job) => job.id === "k1")?.upstream).toBe("https://api.moonshot.ai/anthropic");
    expect(jobs.find((job) => job.id === "q1")?.upstream).toBe("");
  });

  it("keeps a job live only while the engine is still working it", () => {
    const { env, home } = makeJobEnv();
    const cases: Array<[string, string | null, boolean]> = [
      ["t-queued", "queued", true],
      ["t-running", "running", true],
      ["t-verifying", "verifying", true],
      ["t-awaiting-review", "awaiting_review", false],
      ["t-accepted", "accepted", false],
      ["t-discarded", "discarded", false],
      ["t-failed", "failed", false],
      ["t-unknown", "some-new-state", false],
      ["t-none", null, false],
    ];
    for (const [dirName, state] of cases) {
      const job: Record<string, unknown> = {};
      if (state !== null) job.state = state;
      writeJob(stateRoot(home, "zai"), dirName, JSON.stringify(job));
    }
    const jobs = readJobs(env);
    for (const [dirName, , live] of cases) {
      expect(jobs.find((job) => job.id === dirName)?.live).toBe(live);
    }
  });

  it("takes the freshest attempt mtime over a stale updatedAt, ignoring broken symlinks", () => {
    const { env, home } = makeJobEnv();
    const dir = writeJob(
      stateRoot(home, "zai"),
      "live",
      JSON.stringify({ updatedAt: "2020-01-01T00:00:00Z" }),
      ["attempt-1.jsonl"],
    );
    symlinkSync(join(dir, "attempt-none.jsonl"), join(dir, "attempt-9.jsonl")); // dangling on purpose
    const job = readJobs(env)[0];
    expect(job?.attempts.map((attempt) => attempt.file)).toEqual([
      join(dir, "attempt-1.jsonl"),
      join(dir, "attempt-9.jsonl"),
    ]);
    expect(job?.updatedAt).not.toBe(Date.parse("2020-01-01T00:00:00Z"));
    expect(job?.updatedAt ?? 0).toBeGreaterThan(Date.now() - 60_000); // the attempt we just touched
  });

  it("orders jobs newest-first, updatedAt-less jobs last", () => {
    const { env, home } = makeJobEnv();
    writeJob(stateRoot(home, "zai"), "b", JSON.stringify({ updatedAt: "2030-01-02T00:00:00Z" }));
    writeJob(stateRoot(home, "zai"), "c", JSON.stringify({}));
    writeJob(stateRoot(home, "zai"), "a", JSON.stringify({ updatedAt: "2030-01-03T00:00:00Z" }));
    expect(readJobs(env).map((job) => job.id)).toEqual(["a", "b", "c"]);
  });
});

describe("attemptTranscript", () => {
  it("finds an attempt's transcript under any project dir and lists its subagents", () => {
    const { env } = makeJobEnv();
    const claudeHome = jobClaudeHome(env, "kimi");
    const transcript = writeText(
      join(claudeHome, "projects", "-w-main", "att-1.jsonl"),
      jsonl([{ type: "user", timestamp: "2026-01-01T00:00:00.000Z" }]),
    );
    const subagent = writeText(
      join(claudeHome, "projects", "-w-main", "att-1", "subagents", "agent-x.jsonl"),
      "",
    );
    expect(attemptTranscript(claudeHome, "att-1")).toEqual({
      file: transcript,
      subagents: [subagent],
    });
  });

  it("returns null when no project dir holds the session, or the session has none", () => {
    const { env, home } = makeJobEnv();
    const claudeHome = jobClaudeHome(env, "kimi");
    writeText(join(claudeHome, "projects", "-w-main", "other.jsonl"), "");
    expect(attemptTranscript(claudeHome, "att-9")).toBeNull();
    expect(attemptTranscript(join(home, "nope"), "att-9")).toBeNull();
  });
});
