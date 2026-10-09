import type { Brief } from "../../src/domain/brief.ts";
import type {
  Attempt,
  ChangeSet,
  GateResult,
  Job,
  ReportCheck,
  ScopeCheck,
  Verification,
} from "../../src/domain/job.ts";

/** Typed test builders: sensible defaults, shallow overrides. */

export function aBrief(overrides: Partial<Brief> = {}): Brief {
  return {
    title: "Rename the helper",
    body: "Rename `foo` to `bar` everywhere.",
    model: "main",
    mode: "edit",
    cwd: "/repo",
    base: "HEAD",
    scope: ["**"],
    forbid: [],
    gates: [],
    timeoutMs: 2 * 60 * 60 * 1000,
    retries: { fix: 1, infra: 2 },
    report: { kind: "builtin", name: "change" },
    addDirs: [],
    env: [],
    tags: [],
    ...overrides,
  };
}

export function aChangeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return { added: [], modified: [], deleted: [], untracked: [], ...overrides };
}

export function aGateResult(overrides: Partial<GateResult> = {}): GateResult {
  return { run: "npm test", exitCode: 0, timedOut: false, durationMs: 1000, tail: "", ...overrides };
}

export function aScopeCheck(overrides: Partial<ScopeCheck> = {}): ScopeCheck {
  return { outOfScope: [], forbidden: [], repoChanged: false, ...overrides };
}

export function aReportCheck(overrides: Partial<ReportCheck> = {}): ReportCheck {
  return { present: true, valid: true, problems: [], ...overrides };
}

export function aVerification(overrides: Partial<Verification> = {}): Verification {
  return {
    gates: [],
    changes: aChangeSet(),
    scope: aScopeCheck(),
    report: aReportCheck(),
    ...overrides,
  };
}

export function anAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    n: 1,
    kind: "initial",
    prompt: "Rename `foo` to `bar` everywhere.",
    sessionId: "00000000-0000-4000-8000-000000000001",
    startedAt: "2026-10-06T00:00:00.000Z",
    ...overrides,
  };
}

export function aJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "j1",
    brief: aBrief(),
    state: "queued",
    workspace: {
      repoRoot: "/repo",
      baseSha: "0000000000000000000000000000000000000000",
      worktree: "/state/worktrees/j1",
      branch: "zai/j1",
      artifactsDir: "/state/jobs/j1/artifacts",
    },
    attempts: [],
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    version: 0,
    ...overrides,
  };
}
