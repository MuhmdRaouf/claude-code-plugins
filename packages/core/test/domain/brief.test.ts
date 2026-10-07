import { describe, expect, it } from "vitest";
import {
  type Brief,
  type BriefContext,
  type BriefError,
  type BuiltinReport,
  briefTemplate,
  type Mode,
  parseBrief,
} from "../../src/domain/brief.ts";
import { parseDuration } from "../../src/domain/brief-duration.ts";
import { err, ok } from "../../src/domain/result.ts";
import { aBrief } from "../support/builders.ts";
import { REFERENCE_CAPS, REFERENCE_PROVIDER } from "../support/provider.ts";

const DURATION_HINT = "use a positive whole number of milliseconds or h/m/s units like 90s, 15m, 2h, 1h30m";

const REPORT_BY_MODE = { edit: "change", exec: "sweep", readonly: "notes" } satisfies Record<
  Mode,
  BuiltinReport
>;

const ctx: BriefContext = { defaultCwd: "/work/repo", provider: REFERENCE_PROVIDER, worker: REFERENCE_CAPS };

/** A brief document: front matter lines between --- fences, then the body. */
function doc(frontMatter: string, body = "Rename `foo` to `bar` everywhere.\n"): string {
  return `---\n${frontMatter}\n---\n${body}`;
}

function parseOk(text: string): Brief {
  const result = parseBrief(text, ctx);
  if (!result.ok) throw new Error(`expected a brief, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function parseErrors(text: string): readonly BriefError[] {
  const result = parseBrief(text, ctx);
  if (result.ok) throw new Error(`expected errors, got ${JSON.stringify(result.value)}`);
  return result.error;
}

describe("parseBrief", () => {
  it("parses title, body and every documented front-matter field", () => {
    const text = doc(
      [
        "title: Rename the helper",
        "model: flash",
        "effort: high",
        "mode: edit",
        "cwd: /work/other",
        "base: main",
        'scope: ["src/**", "test/**"]',
        'forbid: ["src/generated/**"]',
        "gates:",
        "  - npm test",
        "  - { run: npm run lint, timeout: 5m }",
        "setup:",
        "  - npm ci",
        "regenerate:",
        "  - { paths: [package-lock.json], run: npm install --package-lock-only }",
        "timeout: 30m",
        "retries: { fix: 3, infra: 0 }",
        "report: notes",
        "addDirs: [/opt/shared]",
        "env: [GITHUB_TOKEN]",
        "budgetUsd: 2.5",
        "tags: [rename, batch-7]",
      ].join("\n"),
    );
    expect(parseBrief(text, ctx)).toEqual(
      ok({
        title: "Rename the helper",
        body: "Rename `foo` to `bar` everywhere.\n",
        model: "flash",
        effort: "high",
        mode: "edit",
        cwd: "/work/other",
        base: "main",
        scope: ["src/**", "test/**"],
        forbid: ["src/generated/**"],
        gates: [
          { run: "npm test", timeoutMs: 600_000 },
          { run: "npm run lint", timeoutMs: 300_000 },
        ],
        setup: ["npm ci"],
        regenerate: [{ paths: ["package-lock.json"], run: "npm install --package-lock-only" }],
        timeoutMs: 1_800_000,
        retries: { fix: 3, infra: 0 },
        report: { kind: "builtin", name: "notes" },
        addDirs: ["/opt/shared"],
        env: ["GITHUB_TOKEN"],
        budgetUsd: 2.5,
        tags: ["rename", "batch-7"],
      } satisfies Brief),
    );
  });

  it.each([
    "Just a task, no front matter.\n",
    "\n---\ntitle: Late fence\n---\nBody\n",
    "---\ntitle: Never closed\nBody\n",
    "",
  ])("errors no_front_matter when the document has no leading --- block", (text) => {
    expect(parseBrief(text, ctx)).toEqual(err([{ kind: "no_front_matter" }]));
  });

  it("errors yaml with the parser message on malformed YAML", () => {
    const errors = parseErrors(doc("title: [unclosed\nmode: edit"));
    expect(errors).toEqual([{ kind: "yaml", message: expect.stringContaining("Flow sequence") }]);
  });

  it.each(["", "\n", "  \n\t\n"])("errors empty_body when the markdown body is blank", (body) => {
    expect(parseErrors(doc("title: Rename the helper", body))).toEqual([{ kind: "empty_body" }]);
    expect(parseErrors("---\ntitle: Rename the helper\n---")).toEqual([{ kind: "empty_body" }]);
  });

  it("requires title; reports field errors for every invalid field at once, not just the first", () => {
    const errors = parseErrors(
      doc(["mode: write", "effort: medium", "gates: [{ run: '' }]"].join("\n"), "\n"),
    );
    expect(errors).toEqual([
      { kind: "field", field: "title", message: "required" },
      { kind: "field", field: "effort", message: expect.stringContaining("low, high, max") },
      { kind: "field", field: "mode", message: expect.stringContaining("edit") },
      { kind: "field", field: "gates.0.run", message: "must not be empty" },
      { kind: "empty_body" },
    ]);
  });

  it("rejects unknown front-matter keys (typo protection) naming the key", () => {
    const errors = parseErrors(
      doc(["title: Rename the helper", "scopes: [src/**]", "retries: { fixes: 2 }"].join("\n")),
    );
    expect(errors).toHaveLength(2);
    expect(errors).toEqual(
      expect.arrayContaining([
        { kind: "field", field: "scopes", message: "unknown field" },
        { kind: "field", field: "retries.fixes", message: "unknown field" },
      ]),
    );
  });

  it("defaults mode=edit, model=main for edit and flash for exec/readonly", () => {
    expect(parseOk(doc("title: t"))).toMatchObject({ mode: "edit", model: "main" });
    expect(parseOk(doc("title: t\nmode: exec"))).toMatchObject({ mode: "exec", model: "flash" });
    expect(parseOk(doc("title: t\nmode: readonly"))).toMatchObject({ mode: "readonly", model: "flash" });
    expect(parseOk(doc("title: t\nmode: exec\nmodel: glm"))).toMatchObject({ mode: "exec", model: "main" });
  });

  it("defaults scope to ['**'] for edit and [] for exec/readonly; forbid to []", () => {
    expect(parseOk(doc("title: t"))).toMatchObject({ scope: ["**"], forbid: [] });
    expect(parseOk(doc("title: t\nmode: exec"))).toMatchObject({ scope: [], forbid: [] });
    expect(parseOk(doc("title: t\nmode: readonly"))).toMatchObject({ scope: [], forbid: [] });
  });

  it("defaults report to change/sweep/notes by mode; accepts a builtin name or a .json path (resolved against defaultCwd)", () => {
    const builtin = (name: string) => ({ kind: "builtin", name });
    expect(parseOk(doc("title: t")).report).toEqual(builtin("change"));
    expect(parseOk(doc("title: t\nmode: exec")).report).toEqual(builtin("sweep"));
    expect(parseOk(doc("title: t\nmode: readonly")).report).toEqual(builtin("notes"));
    expect(parseOk(doc("title: t\nreport: sweep")).report).toEqual(builtin("sweep"));
    expect(parseOk(doc("title: t\nreport: schemas/audit.json")).report).toEqual({
      kind: "file",
      path: "/work/repo/schemas/audit.json",
    });
    expect(parseOk(doc("title: t\nreport: /etc/zai/audit.json")).report).toEqual({
      kind: "file",
      path: "/etc/zai/audit.json",
    });
    expect(parseErrors(doc("title: t\nreport: summary"))).toEqual([
      { kind: "field", field: "report", message: "must be change, sweep, notes or a path to a .json schema" },
    ]);
  });

  it("defaults timeout 2h, retries {fix: 1, infra: 2}, base HEAD, gates/addDirs/env/tags empty", () => {
    expect(parseOk(doc("title: Rename the helper"))).toStrictEqual(
      aBrief({ cwd: "/work/repo", body: "Rename `foo` to `bar` everywhere.\n" }),
    );
    expect(parseOk(doc("title: t\nretries: { infra: 5 }")).retries).toEqual({ fix: 1, infra: 5 });
    expect(parseOk(doc("title: t\nretries: { fix: 0 }")).retries).toEqual({ fix: 0, infra: 2 });
  });

  it("accepts gates as strings or {run, timeout}; gate timeout defaults to 10m", () => {
    const gates = [
      "gates:",
      "  - npm test",
      "  - run: npm run e2e",
      "    timeout: 1h",
      "  - { run: make lint }",
    ];
    expect(parseOk(doc(["title: t", ...gates].join("\n"))).gates).toEqual([
      { run: "npm test", timeoutMs: 600_000 },
      { run: "npm run e2e", timeoutMs: 3_600_000 },
      { run: "make lint", timeoutMs: 600_000 },
    ]);
    expect(parseErrors(doc("title: t\ngates: [{ run: make, timeout: soon }]"))).toEqual([
      {
        kind: "field",
        field: "gates.0.timeout",
        message: expect.stringContaining('invalid duration "soon"'),
      },
    ]);
    expect(parseErrors(doc("title: t\ngates: [{ cmd: make }]"))).toEqual(
      expect.arrayContaining([{ kind: "field", field: "gates.0.cmd", message: "unknown field" }]),
    );
  });

  it("resolves a relative cwd and addDirs against defaultCwd; keeps absolute ones", () => {
    const brief = parseOk(doc("title: t\ncwd: ../sibling\naddDirs: [docs, /opt/shared, ./vendor/lib]"));
    expect(brief.cwd).toBe("/work/sibling");
    expect(brief.addDirs).toEqual(["/work/repo/docs", "/opt/shared", "/work/repo/vendor/lib"]);
    expect(parseOk(doc("title: t\ncwd: /srv/app")).cwd).toBe("/srv/app");
  });

  it("accepts model ids and tier names: glm-5.3 → main, glm-5.3-flash → flash", () => {
    expect(parseOk(doc("title: t\nmodel: glm-5.3")).model).toBe("main");
    expect(parseOk(doc("title: t\nmodel: glm-5.3-flash")).model).toBe("flash");
    expect(parseOk(doc("title: t\nmodel: flash")).model).toBe("flash");
    expect(parseErrors(doc("title: t\nmodel: sonnet"))).toEqual([
      { kind: "field", field: "model", message: "must be one of glm, glm-5.3, flash, glm-5.3-flash" },
    ]);
  });

  it("rejects negative retries, non-positive timeouts and budgetUsd <= 0", () => {
    const fields = (errors: readonly BriefError[]) =>
      errors.map((error) => ("field" in error ? error.field : error.kind));
    expect(fields(parseErrors(doc("title: t\nretries: { fix: -1, infra: 1.5 }")))).toEqual([
      "retries.fix",
      "retries.infra",
    ]);
    expect(fields(parseErrors(doc("title: t\ntimeout: 0")))).toEqual(["timeout"]);
    expect(fields(parseErrors(doc("title: t\ntimeout: -5m")))).toEqual(["timeout"]);
    expect(fields(parseErrors(doc("title: t\ngates: [{ run: make, timeout: 0s }]")))).toEqual([
      "gates.0.timeout",
    ]);
    expect(fields(parseErrors(doc("title: t\nbudgetUsd: 0")))).toEqual(["budgetUsd"]);
    expect(fields(parseErrors(doc("title: t\nbudgetUsd: -2")))).toEqual(["budgetUsd"]);
    expect(parseOk(doc("title: t\nbudgetUsd: 0.25")).budgetUsd).toBe(0.25);
  });

  it("validates env entries as shell variable names", () => {
    expect(parseOk(doc("title: t\nenv: [GITHUB_TOKEN, _private, npm_config_cache2]")).env).toEqual([
      "GITHUB_TOKEN",
      "_private",
      "npm_config_cache2",
    ]);
    expect(parseErrors(doc("title: t\nenv: [OK, 2FA, MY-VAR, 'A B', 'X=1']"))).toEqual(
      ["env.1", "env.2", "env.3", "env.4"].map((field) => ({
        kind: "field",
        field,
        message: "must be a shell variable name",
      })),
    );
  });

  it("keeps the body byte-exact apart from trimming the separator newline", () => {
    const body = "\n  Indented first line  \n\n---\nnot front matter\n```yaml\nkey: value\n```\n\n\n";
    expect(parseOk(doc("title: t", body)).body).toBe(body);
    expect(parseOk("---\r\ntitle: t\r\n---\r\nLine one\r\nLine two\r\n").body).toBe(
      "Line one\r\nLine two\r\n",
    );
    expect(parseOk("---\ntitle: t\n---\nNo trailing newline").body).toBe("No trailing newline");
  });

  it("treats empty front matter as no fields and a non-mapping one as a front-matter error", () => {
    expect(parseErrors("---\n---\nBody\n")).toEqual([{ kind: "field", field: "title", message: "required" }]);
    expect(parseErrors(doc("- just\n- a list"))).toEqual([
      { kind: "field", field: "front matter", message: expect.stringContaining("expected object") },
    ]);
  });

  it("allows trailing whitespace after either fence", () => {
    expect(parseOk("---  \ntitle: t\n--- \t\nBody\n")).toMatchObject({ title: "t", body: "Body\n" });
  });

  it("trims text fields and rejects blank ones", () => {
    expect(parseOk(doc("title: '  Padded title  '\ngates: ['  npm test  ']"))).toMatchObject({
      title: "Padded title",
      gates: [{ run: "npm test", timeoutMs: 600_000 }],
    });
    expect(parseErrors(doc("title: '   '\ngates: [{ run: '  ' }]"))).toEqual([
      { kind: "field", field: "title", message: "must not be empty" },
      { kind: "field", field: "gates.0.run", message: "must not be empty" },
    ]);
  });

  it.each(REFERENCE_CAPS.efforts)("accepts every effort level", (effort) => {
    expect(parseOk(doc(`title: t\neffort: ${effort}`)).effort).toBe(effort);
  });

  it.each(["medium", "xhigh", "ultra"] as const)(
    "rejects any other effort level, naming the valid set in the message",
    (effort) => {
      expect(parseErrors(doc(`title: t\neffort: ${effort}`))).toEqual([
        { kind: "field", field: "effort", message: "must be one of low, high, max" },
      ]);
    },
  );
});

describe("parseDuration", () => {
  it.each([
    ["90s", 90_000],
    ["15m", 900_000],
    ["2h", 7_200_000],
    ["1h30m", 5_400_000],
    ["1h0m5s", 3_605_000],
    ["2m30s", 150_000],
    [" 45m ", 2_700_000],
    ["12h", 43_200_000],
    ["100m", 6_000_000],
  ] as const)("parses 90s, 15m, 2h and compound 1h30m into milliseconds", (text, ms) => {
    expect(parseDuration(text)).toEqual(ok(ms));
  });

  it("passes through a positive integer number of milliseconds", () => {
    expect(parseDuration(1)).toEqual(ok(1));
    expect(parseDuration(5000)).toEqual(ok(5000));
    expect(parseDuration("5000")).toEqual(ok(5000));
  });

  it.each([
    "",
    "   ",
    "0",
    0,
    "0s",
    "0h0m",
    -5,
    "-5m",
    1.5,
    "1.5h",
    "5d",
    "10ms",
    "m",
    "30m1h",
    "1 h",
    "Infinity",
    "1e3",
    "+5000",
    "0x10",
    Number.NaN,
  ])("rejects empty, zero, negative, fractional units and unknown suffixes with a message", (text) => {
    expect(parseDuration(text)).toEqual(err(`invalid duration "${text}": ${DURATION_HINT}`));
  });
});

describe("briefTemplate", () => {
  it.each(["edit", "exec", "readonly"] as const)(
    "renders a template that parseBrief accepts after the TODO body is filled in (round trip)",
    (mode) => {
      const title = 'Audit: the "legacy" #handlers';
      const template = briefTemplate(title, mode, REFERENCE_PROVIDER, REFERENCE_CAPS);
      expect(template).toContain("TODO");
      const filled = template.replace(/^TODO.*$/m, "Find every legacy handler.");
      expect(parseBrief(filled, ctx)).toEqual(
        ok(
          aBrief({
            title,
            body: "Find every legacy handler.\n",
            mode,
            model: mode === "edit" ? "main" : "flash",
            cwd: "/work/repo",
            scope: mode === "edit" ? ["**"] : [],
            report: { kind: "builtin", name: REPORT_BY_MODE[mode] },
          }),
        ),
      );
    },
  );

  it("documents every field as a YAML comment and sets mode-specific defaults", () => {
    const fields = ["title", "model", "effort", "mode", "cwd", "base", "scope", "forbid", "gates", "timeout"];
    const moreFields = ["retries", "report", "addDirs", "env", "budgetUsd", "tags"];
    const allFields = [...fields, ...moreFields];
    const isFieldLine = (line = "") =>
      allFields.some((f) => line.startsWith(`${f}:`) || line.startsWith(`# ${f}:`));
    const lines = briefTemplate("t", "exec", REFERENCE_PROVIDER, REFERENCE_CAPS).split("\n");
    for (const field of allFields) {
      const at = lines.findIndex((line) => line.startsWith(`${field}:`) || line.startsWith(`# ${field}:`));
      expect(at, field).toBeGreaterThan(0);
      expect(lines[at - 1], `comment above ${field}`).toMatch(/^# [A-Za-z]/);
      expect(isFieldLine(lines[at - 1]), `comment above ${field} is prose`).toBe(false);
    }
    expect(lines).toEqual(
      expect.arrayContaining(["mode: exec", "model: flash", "scope: []", "report: sweep"]),
    );
    expect(briefTemplate("t", "readonly", REFERENCE_PROVIDER, REFERENCE_CAPS).split("\n")).toEqual(
      expect.arrayContaining(["mode: readonly", "model: flash", "scope: []", "report: notes"]),
    );
    expect(briefTemplate("t", "edit", REFERENCE_PROVIDER, REFERENCE_CAPS).split("\n")).toEqual(
      expect.arrayContaining(["mode: edit", "model: glm", 'scope: ["**"]', "report: change"]),
    );
  });

  it("documents the worker's effort levels in the comment", () => {
    expect(briefTemplate("t", "edit", REFERENCE_PROVIDER, REFERENCE_CAPS)).toContain(
      `# ${REFERENCE_CAPS.efforts.join(" | ")}, passed to claude --effort. Default: unset.`,
    );
  });

  it("is stable: snapshot of the edit template", () => {
    expect(
      briefTemplate("Rename the helper", "edit", REFERENCE_PROVIDER, REFERENCE_CAPS),
    ).toMatchInlineSnapshot(`
      "---
      # Short name shown on the board and in commit messages.
      title: "Rename the helper"
      # edit: own git worktree and branch zai/<id>; the worker may change files inside scope.
      # exec: may run commands but must not change the repository; outputs go to $ZAI_ARTIFACTS.
      # readonly: plan mode, read tools only.
      mode: edit
      # glm (glm-5.3) or flash (glm-5.3-flash). Default: glm for edit, flash otherwise.
      model: glm
      # low | high | max, passed to claude --effort. Default: unset.
      # effort: high
      # Repository the job works on; a relative path resolves against the default, the current git root.
      # cwd: .
      # Ref the worktree starts from.
      base: HEAD
      # Globs the change set may touch (picomatch, dotfiles included). Default: everything for edit, nothing otherwise.
      scope: ["**"]
      # Globs that must stay untouched even inside scope.
      forbid: []
      # Shell commands the plugin runs in the workspace after the worker, each a string or {run, timeout} (default 10m).
      # Example: [npm test, { run: npm run lint, timeout: 5m }]
      gates: []
      # Per attempt: 90s, 15m, 2h, 1h30m or milliseconds.
      timeout: 2h
      # fix: auto-fix rounds after a failed verdict; infra: re-runs after infrastructure errors.
      retries: { fix: 1, infra: 2 }
      # Report contract: change, sweep, notes or a path to a JSON schema file. Default: by mode.
      report: change
      # Extra readable paths, passed as --add-dir.
      addDirs: []
      # Names of orchestrator environment variables passed to the worker and gates; values are never stored.
      env: []
      # Spending cap in USD, passed as --max-budget-usd. Default: unset.
      # budgetUsd: 2
      # high or normal: among jobs waiting for a free slot, high goes first. Default: high (run), normal (batch).
      # priority: normal
      # Free labels for batches and board filters.
      tags: []
      ---
      TODO: describe the task for the worker: what to change, where, and what done looks like.
      "
    `);
  });
});
