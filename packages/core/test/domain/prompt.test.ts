import { describe, expect, it } from "vitest";
import type { Attempt, Verdict, Verification } from "../../src/domain/job.ts";
import {
  autoFixPrompt,
  initialPrompt,
  reviewFixPrompt,
  selfContainedPrompt,
} from "../../src/domain/prompt.ts";
import { attemptSummary } from "../../src/domain/prompt-summary.ts";
import {
  aBrief,
  aChangeSet,
  aGateResult,
  anAttempt,
  aReportCheck,
  aScopeCheck,
  aVerification,
} from "../support/builders.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";

const ARTIFACTS = "/state/jobs/j1/artifacts";

/** A finished attempt that failed verification in the given ways (everything else clean). */
function failedAttempt(verdict: Verdict, verification: Partial<Verification> = {}): Attempt {
  return anAttempt({ outcome: { kind: "completed" }, verification: aVerification(verification), verdict });
}

describe("initialPrompt", () => {
  it("starts with the brief body verbatim and ends with the contract footer", () => {
    const body = "Rename `foo` to `bar`.\n\n  - keep the *exact* spacing  \n";
    const prompt = initialPrompt(aBrief({ body }), ARTIFACTS, REFERENCE_PROVIDER);
    expect(prompt.startsWith(body)).toBe(true);
    expect(prompt.slice(body.length)).toMatch(/^\n## zai contract\n/);
    expect(prompt.endsWith("\n")).toBe(true);
    expect(initialPrompt(aBrief({ body: "No trailing newline" }), ARTIFACTS, REFERENCE_PROVIDER)).toMatch(
      /^No trailing newline\n\n## zai contract\n/,
    );
  });

  it("edit footer: names the worktree rule, lists scope and forbid globs, says do not commit", () => {
    const brief = aBrief({ mode: "edit", scope: ["src/**", "test/**"], forbid: ["src/generated/**"] });
    const prompt = initialPrompt(brief, ARTIFACTS, REFERENCE_PROVIDER);
    expect(prompt).toContain("isolated git worktree");
    expect(prompt).toContain("Change only files matching these globs:\n- `src/**`\n- `test/**`\n");
    expect(prompt).toContain(
      "Never touch files matching these globs, even inside scope:\n- `src/generated/**`\n",
    );
    expect(prompt).toContain("Do not commit");
    expect(initialPrompt(aBrief({ mode: "edit", forbid: [] }), ARTIFACTS, REFERENCE_PROVIDER)).not.toContain(
      "Never touch",
    );
  });

  it("exec footer: says the repository must stay unchanged and names the artifacts dir", () => {
    const prompt = initialPrompt(aBrief({ mode: "exec", scope: [] }), ARTIFACTS, REFERENCE_PROVIDER);
    expect(prompt).toContain("The repository must stay unchanged");
    expect(prompt).toContain(`Write every output file to ${ARTIFACTS} (also in $ZAI_ARTIFACTS).`);
    expect(prompt).not.toContain("worktree");
    expect(prompt).not.toContain("Change only files matching");
    expect(prompt).toContain("Do not commit");
  });

  it("readonly footer: says read-only investigation, no file changes", () => {
    const prompt = initialPrompt(aBrief({ mode: "readonly", scope: [] }), ARTIFACTS, REFERENCE_PROVIDER);
    expect(prompt).toContain("This is a read-only investigation.");
    expect(prompt).toContain("Do not create, edit or delete any file.");
    expect(prompt).not.toContain("worktree");
    expect(prompt).not.toContain(ARTIFACTS);
  });

  it("lists every gate command exactly as the plugin will run it, or says there are none", () => {
    const gates = [
      { run: "npm test -- --reporter=dot", timeoutMs: 600_000 },
      { run: "test \"$(git status --porcelain)\" = ''", timeoutMs: 60_000 },
    ];
    const prompt = initialPrompt(aBrief({ gates }), ARTIFACTS, REFERENCE_PROVIDER);
    expect(prompt).toContain(
      "```sh\nnpm test -- --reporter=dot\ntest \"$(git status --porcelain)\" = ''\n```\n",
    );
    expect(prompt).toContain("Each must exit 0.");
    const withFence = initialPrompt(
      aBrief({ gates: [{ run: "echo '```'", timeoutMs: 1 }] }),
      ARTIFACTS,
      REFERENCE_PROVIDER,
    );
    expect(withFence).toContain("````sh\necho '```'\n````\n");
    const none = initialPrompt(aBrief({ gates: [] }), ARTIFACTS, REFERENCE_PROVIDER);
    expect(none).toContain("No gates: the plugin runs no checks after you finish.");
    expect(none).not.toContain("```sh");
  });

  it.each([
    aBrief({ mode: "edit" }),
    aBrief({ mode: "exec", scope: [], report: { kind: "builtin", name: "sweep" } }),
    aBrief({ mode: "readonly", scope: [], report: { kind: "file", path: "/repo/schemas/audit.json" } }),
  ])("always says never print or write secrets and to finish with the structured report", (brief) => {
    const prompt = initialPrompt(brief, ARTIFACTS, REFERENCE_PROVIDER);
    expect(prompt).toContain("Never print, log or write secrets");
    expect(prompt).toMatch(/End your run with the structured report[^\n]*\n$/);
    const report = brief.report;
    expect(prompt).toContain(
      report.kind === "builtin" ? `(schema: ${report.name})` : `(schema file: ${report.path})`,
    );
  });

  it("is stable: snapshot of an edit brief without forbid globs or gates", () => {
    expect(initialPrompt(aBrief(), ARTIFACTS, REFERENCE_PROVIDER)).toMatchInlineSnapshot(`
      "Rename \`foo\` to \`bar\` everywhere.

      ## zai contract

      You work in an isolated git worktree of the repository. Edit files only there.
      Change only files matching these globs:
      - \`**\`
      Leave your changes in the working tree. The plugin reviews and commits them.
      Do not commit, stage, stash or switch branches.
      Never print, log or write secrets: API keys, tokens, passwords, private keys.

      ## Gates

      No gates: the plugin runs no checks after you finish.

      ## Finish

      End your run with the structured report (schema: change). Report only what you did and checked.
      "
    `);
  });

  it("is stable: snapshot per mode", () => {
    const gates = [
      { run: "npm test", timeoutMs: 600_000 },
      { run: "npm run lint", timeoutMs: 300_000 },
    ];
    expect(
      initialPrompt(
        aBrief({ mode: "edit", scope: ["src/**"], forbid: ["src/generated/**"], gates }),
        ARTIFACTS,
        REFERENCE_PROVIDER,
      ),
    ).toMatchInlineSnapshot(`
        "Rename \`foo\` to \`bar\` everywhere.

        ## zai contract

        You work in an isolated git worktree of the repository. Edit files only there.
        Change only files matching these globs:
        - \`src/**\`
        Never touch files matching these globs, even inside scope:
        - \`src/generated/**\`
        Leave your changes in the working tree. The plugin reviews and commits them.
        Do not commit, stage, stash or switch branches.
        Never print, log or write secrets: API keys, tokens, passwords, private keys.

        ## Gates

        After you finish, the plugin runs these commands in your workspace. Each must exit 0.
        \`\`\`sh
        npm test
        npm run lint
        \`\`\`

        ## Finish

        Run the gates yourself before you finish. Fix what fails.
        End your run with the structured report (schema: change). Report only what you did and checked.
        "
      `);
    expect(
      initialPrompt(
        aBrief({ mode: "exec", scope: [], gates, report: { kind: "builtin", name: "sweep" } }),
        ARTIFACTS,
        REFERENCE_PROVIDER,
      ),
    ).toMatchInlineSnapshot(`
      "Rename \`foo\` to \`bar\` everywhere.

      ## zai contract

      You work directly in the repository. The repository must stay unchanged.
      Do not create, edit or delete files in it.
      Write every output file to /state/jobs/j1/artifacts (also in $ZAI_ARTIFACTS).
      Do not commit, stage, stash or switch branches.
      Never print, log or write secrets: API keys, tokens, passwords, private keys.

      ## Gates

      After you finish, the plugin runs these commands in your workspace. Each must exit 0.
      \`\`\`sh
      npm test
      npm run lint
      \`\`\`

      ## Finish

      Run the gates yourself before you finish. Fix what fails.
      End your run with the structured report (schema: sweep). Report only what you did and checked.
      "
    `);
    expect(
      initialPrompt(
        aBrief({ mode: "readonly", scope: [], report: { kind: "builtin", name: "notes" } }),
        ARTIFACTS,
        REFERENCE_PROVIDER,
      ),
    ).toMatchInlineSnapshot(`
      "Rename \`foo\` to \`bar\` everywhere.

      ## zai contract

      This is a read-only investigation. Read and search; run only commands that change nothing.
      Do not create, edit or delete any file.
      Do not commit, stage, stash or switch branches.
      Never print, log or write secrets: API keys, tokens, passwords, private keys.

      ## Gates

      No gates: the plugin runs no checks after you finish.

      ## Finish

      End your run with the structured report (schema: notes). Report only what you did and checked.
      "
    `);
  });
});

describe("autoFixPrompt", () => {
  it("names the verdict and quotes each failing gate with command, exit code or 'timed out', and its tail", () => {
    const failed = failedAttempt("gate_fail", {
      gates: [
        aGateResult({ run: "npm run build", exitCode: 0, tail: "built" }),
        aGateResult({ run: "npm test", exitCode: 1, tail: "FAIL src/a.test.ts\n  expected 2, got 3" }),
        aGateResult({ run: "npm run e2e", exitCode: null, timedOut: true, tail: "waiting for server" }),
        aGateResult({ run: "make lint", exitCode: null, tail: "" }),
      ],
    });
    const prompt = autoFixPrompt(aBrief(), failed);
    expect(prompt).toMatch(/^Verification failed: gate_fail\.\n/);
    expect(prompt).toContain(
      "Gate failed: `npm test` (exit 1)\n```text\nFAIL src/a.test.ts\n  expected 2, got 3\n```\n",
    );
    expect(prompt).toContain("Gate failed: `npm run e2e` (timed out)\n```text\nwaiting for server\n```\n");
    expect(prompt).toContain("Gate failed: `make lint` (killed, no exit code)\n```text\n(no output)\n```\n");
    expect(prompt).not.toContain("npm run build");
  });

  it("bounds each tail to limits.gateTailChars, keeping the END of the output, with a truncation marker", () => {
    const tail = `${"x".repeat(30)}THE END`;
    const failed = failedAttempt("gate_fail", { gates: [aGateResult({ exitCode: 1, tail })] });
    const prompt = autoFixPrompt(aBrief(), failed, { gateTailChars: 10, pathsListed: 50 });
    expect(prompt).toContain("```text\n[27 earlier characters cut]\nxxxTHE END\n```");
    const exact = failedAttempt("gate_fail", { gates: [aGateResult({ exitCode: 1, tail: "0123456789" })] });
    expect(autoFixPrompt(aBrief(), exact, { gateTailChars: 10, pathsListed: 50 })).toContain(
      "```text\n0123456789\n```",
    );
  });

  it("lists outOfScope and forbidden paths up to limits.pathsListed with an 'and N more' line", () => {
    const failed = failedAttempt("scope_violation", {
      scope: aScopeCheck({ outOfScope: ["README.md", "docs/a.md", "docs/b.md"], forbidden: [".env"] }),
    });
    const prompt = autoFixPrompt(aBrief(), failed, { gateTailChars: 4000, pathsListed: 2 });
    expect(prompt).toContain(
      "Changed outside scope. Revert these changes:\n- `README.md`\n- `docs/a.md`\n- and 1 more\n",
    );
    expect(prompt).toContain("Changed forbidden paths. Revert these changes:\n- `.env`\n");
    expect(prompt).not.toContain("and 0 more");
    const exactlyMax = failedAttempt("scope_violation", {
      scope: aScopeCheck({ outOfScope: ["a.md", "b.md"] }),
    });
    expect(autoFixPrompt(aBrief(), exactlyMax, { gateTailChars: 4000, pathsListed: 2 })).toContain(
      "Revert these changes:\n- `a.md`\n- `b.md`\n\nMake the smallest change",
    );
  });

  it.each(["exec", "readonly"] as const)(
    "says repository changed for exec/readonly scope violations",
    (mode) => {
      const failed = failedAttempt("scope_violation", {
        changes: aChangeSet({ modified: ["src/a.ts"], untracked: ["out.json", "notes.md"] }),
        scope: aScopeCheck({ repoChanged: true }),
      });
      const prompt = autoFixPrompt(aBrief({ mode, scope: [] }), failed, {
        gateTailChars: 4000,
        pathsListed: 2,
      });
      expect(prompt).toContain(
        "The repository changed, but this job must leave it unchanged. Revert these changes:\n- `notes.md`\n- `out.json`\n- and 1 more\n",
      );
    },
  );

  it("for report_invalid quotes the report problems", () => {
    const invalid = failedAttempt("report_invalid", {
      report: aReportCheck({ valid: false, problems: ["summary: Required", "files.0.why: Expected string"] }),
    });
    expect(autoFixPrompt(aBrief(), invalid)).toContain(
      "The structured report is invalid:\n- summary: Required\n- files.0.why: Expected string\n",
    );
    const missing = failedAttempt("report_invalid", {
      report: aReportCheck({ present: false, valid: false }),
    });
    expect(autoFixPrompt(aBrief(), missing)).toContain("The structured report is missing.");
  });

  it("does not repeat the brief body", () => {
    const brief = aBrief({ body: "UNIQUE-BRIEF-BODY: rename every helper." });
    const failed = failedAttempt("gate_fail", { gates: [aGateResult({ exitCode: 1, tail: "boom" })] });
    const prompt = autoFixPrompt(brief, failed);
    expect(prompt).not.toContain("UNIQUE-BRIEF-BODY");
    expect(prompt).not.toContain("## zai contract");
  });

  it("asks for the smallest change that fixes exactly these failures", () => {
    const failed = failedAttempt("gate_fail", { gates: [aGateResult({ exitCode: 1, tail: "boom" })] });
    expect(autoFixPrompt(aBrief(), failed)).toMatch(
      /\n\nMake the smallest change that fixes exactly these failures\. Keep everything else as it is\.\n[^\n]*structured report[^\n]*\n$/,
    );
  });

  it("names only the verdict when the attempt was never verified", () => {
    const crashed = anAttempt({ verdict: "worker_error", outcome: { kind: "timeout" } });
    expect(autoFixPrompt(aBrief(), crashed)).toMatch(
      /^Verification failed: worker_error\.\n\nMake the smallest change/,
    );
    expect(autoFixPrompt(aBrief(), anAttempt())).toMatch(/^Verification failed: no verdict\.\n/);
  });

  it("does not add a blank line inside the fence when the tail already ends with a newline", () => {
    const failed = failedAttempt("gate_fail", { gates: [aGateResult({ exitCode: 2, tail: "boom\n" })] });
    expect(autoFixPrompt(aBrief(), failed)).toContain("(exit 2)\n```text\nboom\n```\n");
  });

  it("is stable: snapshot of a mixed failure", () => {
    const failed = failedAttempt("scope_violation", {
      gates: [
        aGateResult({ run: "npm run build" }),
        aGateResult({ run: "npm test", exitCode: 1, tail: "1 failed" }),
      ],
      changes: aChangeSet({ modified: ["src/a.ts", "README.md"] }),
      scope: aScopeCheck({ outOfScope: ["README.md"] }),
      report: aReportCheck({ valid: false, problems: ["summary: Required"] }),
    });
    expect(autoFixPrompt(aBrief(), failed)).toMatchInlineSnapshot(`
      "Verification failed: scope_violation.

      Changed outside scope. Revert these changes:
      - \`README.md\`

      The structured report is invalid:
      - summary: Required

      Gate failed: \`npm test\` (exit 1)
      \`\`\`text
      1 failed
      \`\`\`

      Make the smallest change that fixes exactly these failures. Keep everything else as it is.
      The contract from your first message still applies. End your run with the structured report.
      "
    `);
  });

  it("is stable: snapshot of a single gate failure (no scope or report sections)", () => {
    const failed = failedAttempt("gate_fail", { gates: [aGateResult({ exitCode: 1, tail: "1 failed" })] });
    expect(autoFixPrompt(aBrief(), failed)).toMatchInlineSnapshot(`
      "Verification failed: gate_fail.

      Gate failed: \`npm test\` (exit 1)
      \`\`\`text
      1 failed
      \`\`\`

      Make the smallest change that fixes exactly these failures. Keep everything else as it is.
      The contract from your first message still applies. End your run with the structured report.
      "
    `);
  });
});

describe("reviewFixPrompt", () => {
  it("carries the reviewer feedback verbatim, clearly delimited", () => {
    const feedback =
      "Also rename the CLI flag.\n\n```ts\nconst bar = 1;\n```\n  Keep the old flag as an alias.";
    const prompt = reviewFixPrompt(aBrief(), failedAttempt("pass"), feedback);
    expect(prompt).toMatch(/^The reviewer returned your work with this feedback:\n/);
    expect(prompt).toContain(`\`\`\`\`text\n${feedback}\n\`\`\`\`\n`);
  });

  it("includes a one-line verification summary of the last attempt", () => {
    const passed = anAttempt({
      n: 2,
      kind: "auto_fix",
      verdict: "pass",
      verification: aVerification({
        gates: [aGateResult(), aGateResult({ run: "npm run lint" })],
        changes: aChangeSet({ modified: ["src/a.ts", "src/b.ts"], added: ["src/c.ts"] }),
      }),
    });
    expect(reviewFixPrompt(aBrief(), passed, "Rename the flag too.")).toContain(
      "\n\nLast attempt #2 (auto_fix): pass; gates 2/2 passed; 3 changed paths, in scope; report valid.\n",
    );
  });

  it("quotes the last attempt's failures, bounded by limits, when it did not pass", () => {
    const failed = failedAttempt("gate_fail", { gates: [aGateResult({ exitCode: 1, tail: "0123456789" })] });
    const prompt = reviewFixPrompt(aBrief(), failed, "Fix the test.", { gateTailChars: 4, pathsListed: 50 });
    expect(prompt).toContain(
      "Gate failed: `npm test` (exit 1)\n```text\n[6 earlier characters cut]\n6789\n```\n",
    );
    expect(reviewFixPrompt(aBrief(), failedAttempt("pass"), "Fix the test.")).not.toContain("Gate failed");
  });

  it("ends by asking for the smallest change that addresses the feedback, under the same contract", () => {
    expect(reviewFixPrompt(aBrief(), failedAttempt("pass"), "Rename the flag too.")).toMatch(
      /\n\nAddress the feedback with the smallest change that satisfies it\. Keep everything else as it is\.\nThe contract from your first message still applies\. End your run with the structured report\.\n$/,
    );
  });
});

describe("selfContainedPrompt", () => {
  it("contains the brief body, one line per previous attempt (n, kind, verdict) and the new instruction", () => {
    const history = [
      failedAttempt("gate_fail", { gates: [aGateResult({ exitCode: 1 })] }),
      anAttempt({ n: 2, kind: "auto_fix", verdict: "worker_error", outcome: { kind: "timeout" } }),
      anAttempt({ n: 3, kind: "infra_retry", verdict: "pass", verification: aVerification() }),
    ];
    const brief = aBrief({ body: "Rename `foo` to `bar` everywhere.\n" });
    const prompt = selfContainedPrompt(
      brief,
      history,
      "Also rename the CLI flag; keep --foo as an alias.",
      ARTIFACTS,
      REFERENCE_PROVIDER,
    );
    expect(prompt.startsWith(brief.body)).toBe(true);
    expect(prompt).toContain(
      [
        "## Earlier attempts",
        "",
        "This task was attempted before in another session. Results:",
        "- #1 (initial): gate_fail; gates 0/1 passed (failing: `npm test`); 0 changed paths, in scope; report valid.",
        "- #2 (auto_fix): worker_error; not verified.",
        "- #3 (infra_retry): pass; no gates; 0 changed paths, in scope; report valid.",
        "",
        "## Now",
        "",
        "Also rename the CLI flag; keep --foo as an alias.",
        "",
      ].join("\n"),
    );
  });

  it("includes the footer, artifacts dir named, so the fresh session knows the contract", () => {
    const edit = aBrief({ gates: [{ run: "npm test", timeoutMs: 600_000 }] });
    const prompt = selfContainedPrompt(
      edit,
      [failedAttempt("gate_fail")],
      "Fix the failing test.",
      ARTIFACTS,
      REFERENCE_PROVIDER,
    );
    expect(prompt).toMatch(/\nFix the failing test\.\n\n## zai contract\n/);
    expect(
      prompt.endsWith(initialPrompt(edit, ARTIFACTS, REFERENCE_PROVIDER).slice(edit.body.length + 1)),
    ).toBe(true);
    const exec = selfContainedPrompt(
      aBrief({ mode: "exec", scope: [] }),
      [],
      "Retry.",
      ARTIFACTS,
      REFERENCE_PROVIDER,
    );
    expect(exec).toContain(`Write every output file to ${ARTIFACTS} (also in $ZAI_ARTIFACTS).`);
  });

  it("omits the history section when there were no earlier attempts", () => {
    const prompt = selfContainedPrompt(aBrief(), [], "Start over.", ARTIFACTS, REFERENCE_PROVIDER);
    expect(prompt).not.toContain("Earlier attempts");
    expect(prompt).toMatch(
      /^Rename `foo` to `bar` everywhere\.\n\n## Now\n\nStart over\.\n\n## zai contract\n/,
    );
  });

  it("separates the body from the next section by exactly one blank line", () => {
    const prompt = selfContainedPrompt(
      aBrief({ body: "Do it.\n\n\n" }),
      [],
      "Again.",
      ARTIFACTS,
      REFERENCE_PROVIDER,
    );
    expect(prompt).toMatch(/^Do it\.\n\n## Now\n/);
  });
});

describe("attemptSummary", () => {
  it.each([
    [anAttempt({ n: 4, kind: "review_fix" }), "#4 (review_fix): no verdict; not verified."],
    [
      failedAttempt("scope_violation", {
        changes: aChangeSet({ modified: ["a.ts"] }),
        scope: aScopeCheck({ outOfScope: ["a.ts"], forbidden: [".env", "b.pem"] }),
        report: aReportCheck({ present: false, valid: false }),
      }),
      "#1 (initial): scope_violation; no gates; 1 changed path, 1 out of scope, 2 forbidden; report missing.",
    ],
    [
      failedAttempt("scope_violation", {
        changes: aChangeSet({ untracked: ["out.txt"] }),
        scope: aScopeCheck({ repoChanged: true }),
        report: aReportCheck({ valid: false, problems: ["summary: Required"] }),
      }),
      "#1 (initial): scope_violation; no gates; 1 changed path, repository changed; report invalid.",
    ],
    [
      failedAttempt("scope_violation", { scope: aScopeCheck({ forbidden: [".env"] }) }),
      "#1 (initial): scope_violation; no gates; 0 changed paths, 1 forbidden; report valid.",
    ],
    [
      failedAttempt("gate_fail", {
        gates: [aGateResult({ run: "a", exitCode: 1 }), aGateResult({ run: "b", timedOut: true })],
      }),
      "#1 (initial): gate_fail; gates 0/2 passed (failing: `a`, `b`); 0 changed paths, in scope; report valid.",
    ],
  ])("summarises verdict, gates, scope and report on one line", (attempt, line) => {
    expect(attemptSummary(attempt)).toBe(line);
  });
});
