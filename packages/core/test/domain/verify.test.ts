import { describe, expect, it } from "vitest";
import { changedPaths, checkScope, deriveVerdict, type ScopeRules } from "../../src/domain/verify.ts";
import { aChangeSet, aGateResult, aReportCheck, aScopeCheck } from "../support/builders.ts";

/** Every verification check failing at once: the outcome alone decides which verdict wins. */
const everythingFailing = {
  gates: [aGateResult({ exitCode: 1 })],
  scope: aScopeCheck({ outOfScope: ["README.md"] }),
  report: aReportCheck({ present: false, valid: false }),
};

const allClean = { gates: [aGateResult()], scope: aScopeCheck(), report: aReportCheck() };

const completed = { kind: "completed" } as const;

const edit = (scope: readonly string[], forbid: readonly string[] = []): ScopeRules => ({
  mode: "edit",
  scope,
  forbid,
});

describe("checkScope", () => {
  it("edit: paths matching scope and no forbid glob are clean", () => {
    const changes = aChangeSet({ modified: ["src/a.ts", "src/b/c.ts"] });
    expect(checkScope(changes, edit(["src/**"], ["src/secret/**"]))).toEqual(aScopeCheck());
  });

  it("edit: a path matching no scope glob is outOfScope", () => {
    const changes = aChangeSet({ modified: ["src/a.ts", "README.md"] });
    expect(checkScope(changes, edit(["src/**"]))).toEqual(aScopeCheck({ outOfScope: ["README.md"] }));
  });

  it("edit: a forbidden path is reported as forbidden even when inside scope (and not double-listed as outOfScope)", () => {
    const changes = aChangeSet({ modified: ["src/a.ts", "src/secret/key.ts", "vendor/x.js"] });
    expect(checkScope(changes, edit(["src/**"], ["src/secret/**", "vendor/**"]))).toEqual(
      aScopeCheck({ outOfScope: [], forbidden: ["src/secret/key.ts", "vendor/x.js"] }),
    );
  });

  it("covers added, modified, deleted and untracked paths alike", () => {
    const changes = aChangeSet({
      added: ["docs/1-added.md"],
      modified: ["docs/2-modified.md"],
      deleted: ["docs/3-deleted.md"],
      untracked: ["docs/4-untracked.md"],
    });
    expect(checkScope(changes, edit(["src/**"], ["docs/4-*"]))).toEqual(
      aScopeCheck({
        outOfScope: ["docs/1-added.md", "docs/2-modified.md", "docs/3-deleted.md"],
        forbidden: ["docs/4-untracked.md"],
      }),
    );
  });

  it("matches dotfiles (dot: true) and nested globs (**/x.ts)", () => {
    const changes = aChangeSet({ modified: ["src/.eslintrc.json", "x.ts", "a/b/x.ts", "src/.keys/id.pem"] });
    expect(checkScope(changes, edit(["src/**", "**/x.ts"], ["**/*.pem"]))).toEqual(
      aScopeCheck({ forbidden: ["src/.keys/id.pem"] }),
    );
  });

  it.each(["exec", "readonly"] as const)(
    "exec/readonly: any change sets repoChanged; no change keeps it false",
    (mode) => {
      const rules: ScopeRules = { mode, scope: [], forbid: [] };
      expect(checkScope(aChangeSet({ untracked: ["notes.txt"] }), rules)).toEqual(
        aScopeCheck({ repoChanged: true }),
      );
      expect(checkScope(aChangeSet(), rules)).toEqual(aScopeCheck({ repoChanged: false }));
    },
  );

  it("results are sorted and de-duplicated", () => {
    const changes = aChangeSet({
      added: ["z.md", "b/.env"],
      modified: ["a.md", "z.md"],
      untracked: ["a/.env", "b/.env"],
    });
    expect(checkScope(changes, edit(["src/**"], ["**/.env"]))).toEqual(
      aScopeCheck({ outOfScope: ["a.md", "z.md"], forbidden: ["a/.env", "b/.env"] }),
    );
  });
});

describe("deriveVerdict", () => {
  it("stopped beats everything", () => {
    expect(deriveVerdict({ outcome: { kind: "stopped" }, ...everythingFailing })).toBe("stopped");
    expect(deriveVerdict({ outcome: { kind: "stopped" }, ...allClean })).toBe("stopped");
  });

  it("timeout beats worker_error and verification failures", () => {
    expect(deriveVerdict({ outcome: { kind: "timeout" }, ...everythingFailing })).toBe("timeout");
  });

  it("an api_error the provider gave for an empty balance → quota", () => {
    const outcome = { kind: "api_error", message: "Insufficient balance", status: 429, quota: true } as const;
    expect(deriveVerdict({ outcome, ...everythingFailing })).toBe("quota");
  });

  it.each([
    { kind: "api_error", message: "429 Too Many Requests", status: 429 },
    { kind: "crashed", exitCode: 1, signal: null, stderrTail: "boom" },
  ] as const)("api_error and crashed → worker_error", (outcome) => {
    expect(deriveVerdict({ outcome, ...everythingFailing })).toBe("worker_error");
    expect(deriveVerdict({ outcome, ...allClean })).toBe("worker_error");
  });

  it.each([
    aScopeCheck({ outOfScope: ["README.md"] }),
    aScopeCheck({ forbidden: [".env"] }),
    aScopeCheck({ repoChanged: true }),
  ])(
    "scope violation (outOfScope, forbidden or repoChanged) → scope_violation before report and gates",
    (scope) => {
      expect(deriveVerdict({ outcome: completed, ...everythingFailing, scope })).toBe("scope_violation");
      expect(deriveVerdict({ outcome: completed, ...allClean, scope })).toBe("scope_violation");
    },
  );

  it.each([
    aReportCheck({ present: false, valid: false }),
    aReportCheck({ present: true, valid: false, problems: ["summary: Required"] }),
    aReportCheck({ present: false, valid: true }),
  ])("missing or invalid report → report_invalid before gates", (report) => {
    const failingGates = [aGateResult({ exitCode: 2 })];
    expect(deriveVerdict({ outcome: completed, ...allClean, gates: failingGates, report })).toBe(
      "report_invalid",
    );
    expect(deriveVerdict({ outcome: completed, ...allClean, report })).toBe("report_invalid");
  });

  it.each([
    [aGateResult(), aGateResult({ run: "npm run lint", exitCode: 1 })],
    [aGateResult({ exitCode: null, timedOut: true })],
    [aGateResult({ exitCode: 0, timedOut: true })],
    [aGateResult({ exitCode: null, timedOut: false })],
  ])("any gate with non-zero exit or timedOut → gate_fail", (...gates) => {
    expect(deriveVerdict({ outcome: completed, ...allClean, gates })).toBe("gate_fail");
  });

  it("completed + clean scope + valid report + all gates 0 → pass (also with zero gates)", () => {
    const gates = [aGateResult(), aGateResult({ run: "npm run lint" })];
    expect(deriveVerdict({ outcome: completed, ...allClean, gates })).toBe("pass");
    expect(deriveVerdict({ outcome: completed, ...allClean, gates: [] })).toBe("pass");
  });
});

describe("changedPaths", () => {
  it("unions all four lists, sorted, without duplicates", () => {
    const changes = aChangeSet({
      added: ["b.ts", "a.ts"],
      modified: ["c.ts", "a.ts"],
      deleted: ["old.ts"],
      untracked: [".env", "b.ts"],
    });
    expect(changedPaths(changes)).toEqual([".env", "a.ts", "b.ts", "c.ts", "old.ts"]);
    expect(changedPaths(aChangeSet())).toEqual([]);
  });
});
