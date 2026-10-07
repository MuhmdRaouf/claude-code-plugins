import { describe, expect, it } from "vitest";
import { type BriefContext, briefTemplate, parseBrief } from "../../src/domain/brief.ts";
import { initialPrompt, selfContainedPrompt } from "../../src/domain/prompt.ts";
import { err } from "../../src/domain/result.ts";
import { aBrief } from "../support/builders.ts";
import { ACME_PROVIDER, ACME_WORKER } from "../support/provider.ts";

const ARTIFACTS = "/state/jobs/j1/artifacts";

describe("prompts and the brief template take every name from the provider", () => {
  it("the contract footer is headed with the provider's name and names its artifacts variable", () => {
    const exec = aBrief({ mode: "exec", scope: [] });
    const prompts = [
      initialPrompt(exec, ARTIFACTS, ACME_PROVIDER),
      selfContainedPrompt(exec, [], "Start over.", ARTIFACTS, ACME_PROVIDER),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain("\n## acme contract\n");
      expect(prompt).toContain(`Write every output file to ${ARTIFACTS} (also in $ACME_OUT).`);
      expect(prompt).not.toMatch(/zai/i);
    }
  });

  it.each(["edit", "exec", "readonly"] as const)(
    "the %s template names the provider's branch, variable and models",
    (mode) => {
      const template = briefTemplate("t", mode, ACME_PROVIDER, ACME_WORKER);

      expect(template).toContain("# edit: own git worktree and branch acme-jobs/<id>;");
      expect(template).toContain("outputs go to $ACME_OUT.");
      expect(template).toContain("# big (big-model-9) or quick (small-model-9).");
      expect(template).not.toMatch(/zai|glm-5\.3/i);
    },
  );
});

describe("a brief means what the provider's catalog and the worker's terms say", () => {
  const acme: BriefContext = { defaultCwd: "/work/repo", provider: ACME_PROVIDER, worker: ACME_WORKER };

  function parsed(frontMatter: string, ctx: BriefContext = acme) {
    return parseBrief(`---\ntitle: t\n${frontMatter}\n---\nDo it.\n`, ctx);
  }

  it("names a tier by itself or by the catalog's model id, never by another provider's id", () => {
    expect(parsed("model: big-model-9")).toMatchObject({ ok: true, value: { model: "main" } });
    expect(parsed("model: small-model-9")).toMatchObject({ ok: true, value: { model: "flash" } });
    expect(parsed("model: glm-5.3")).toEqual(
      err([
        {
          kind: "field",
          field: "model",
          message: "must be one of big, big-model-9, quick, small-model-9",
        },
      ]),
    );
  });

  it("takes each mode's default tier from the provider", () => {
    const flashFirst = {
      ...ACME_PROVIDER,
      defaultTier: { edit: "flash", exec: "main", readonly: "main" },
    } as const;
    const ctx = { ...acme, provider: flashFirst };

    expect(parsed("mode: edit", ctx)).toMatchObject({ ok: true, value: { model: "flash" } });
    expect(parsed("mode: exec", ctx)).toMatchObject({ ok: true, value: { model: "main" } });
  });

  it("accepts the worker's efforts only", () => {
    expect(parsed("effort: fierce")).toMatchObject({ ok: true, value: { effort: "fierce" } });
    expect(parsed("effort: medium")).toEqual(
      err([{ kind: "field", field: "effort", message: "must be one of gentle, firm, fierce" }]),
    );
  });

  it("refuses budgetUsd when the worker has no spending cap", () => {
    expect(parsed("budgetUsd: 2")).toEqual(
      err([{ kind: "field", field: "budgetUsd", message: "the worker has no spending cap; use timeout" }]),
    );
  });

  it("the template lists the worker's efforts and how it takes them, and each mode's default tier", () => {
    const allDifferent = {
      ...ACME_PROVIDER,
      defaultTier: { edit: "main", exec: "flash", readonly: "main" },
    } as const;
    const template = briefTemplate("t", "exec", allDifferent, ACME_WORKER);

    expect(template).toContain(
      "# big (big-model-9) or quick (small-model-9). Default: big for edit, quick for exec,",
    );
    expect(template).toContain("big for readonly.\nmodel: quick\n");
    expect(template).toContain(
      "# gentle | firm | fierce, sent as acmebot --zeal. Default: unset.\n# effort: firm\n",
    );
    expect(template).toContain("# Extra readable paths, mounted read-only.");
    expect(template).toContain(
      "# Spending cap in USD, refused: acmebot has no spending cap. Default: unset.",
    );
    expect(template).not.toMatch(/claude/i);
  });

  it("takes the readonly note from the worker's terms, not from a fixed plan-mode wording", () => {
    const note = "acme answers questions without changing anything";
    const worker = { ...ACME_WORKER, briefNotes: { ...ACME_WORKER.briefNotes, readonly: note } };
    const template = briefTemplate("t", "readonly", ACME_PROVIDER, worker);

    expect(template).toContain(`# readonly: ${note}.`);
    expect(template).not.toMatch(/plan mode/i);
  });
});
