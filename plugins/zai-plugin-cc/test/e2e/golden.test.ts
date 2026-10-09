import { existsSync } from "node:fs";
import { createGitCli } from "@muhmdraouf/core/adapters/git-cli.ts";
import { createShellGates } from "@muhmdraouf/core/adapters/shell-gates.ts";
import type { Deps } from "@muhmdraouf/core/app/deps.ts";
import type { Worker } from "@muhmdraouf/core/ports/index.ts";
import { ACME_PROVIDER, ACME_WORKER } from "@muhmdraouf/core/testing";
import { describe, expect, it } from "vitest";
import { goldenTranscript } from "./golden-flow.ts";

// The oracle for behaviour-preserving refactors: every user-visible string of a scripted session, byte for byte. A
// change here is a change users see; review the diff of zai.transcript.txt like any other output change.
describe("golden transcript (real CLI and adapters, fake claude, pinned clock and ids)", () => {
  it("prints exactly what it printed before", async () => {
    // A missing file would pass (and -u would write it): the golden must already be there.
    expect(existsSync(new URL("golden/zai.transcript.txt", import.meta.url))).toBe(true);
    await expect(await goldenTranscript()).toMatchFileSnapshot("golden/zai.transcript.txt");
  }, 120_000);

  it("names nothing of zai's when the same session runs as a second provider", async () => {
    const transcript = await goldenTranscript(asAcme);

    // The claude worker and its key stay zai's: only the key's source is named, as setup reports it.
    expect(transcript.replaceAll("ZAI_API_KEY", "")).not.toMatch(/zai|z\.ai|glm-5\.3/i);
    for (const name of [
      "$ acme run <sandbox>/edit.md --wait",
      "acme job 261006-000001 started: Fix the value (big-model-9, edit)",
      "acme: unknown command",
      "  run <brief.md|->",
      "  acmebot:  <plugin>/test/support/fake-claude.ts",
      "  ping:     ok: big-model-9 answered",
      "branch acme-jobs/261006-000001",
      "Worked-by: big-model-9 via acme-harness",
      "## acme contract",
      "(also in $ACME_OUT)",
      "\nACME_OUT\n",
      "/acme:review 261006-000001",
      "No Acme Models activity yet.",
    ]) {
      expect(transcript).toContain(name);
    }
  }, 120_000);

  it("names nothing of claude's when the worker's terms are another worker's too", async () => {
    const transcript = await goldenTranscript((deps) => ({
      ...asAcme(deps),
      worker: withTerms(deps.worker),
    }));

    // What still says claude is the claude worker's own: its binary and version line, the env it gives Claude Code,
    // Claude Code's own settings file and restart line, and the fake's FAKE_CLAUDE_* knobs the briefs pass through.
    const own =
      /fake-claude\.ts|\(Claude Code, fake\)|\.claude\/settings\.json|Restart Claude Code|\b(?:FAKE_)?CLAUDE_[A-Z_]+\b/g;
    expect(transcript.replaceAll(own, "")).not.toMatch(/claude/i);
    expect(transcript).toContain("# gentle | firm | fierce, sent as acmebot --zeal. Default: unset.");
    expect(transcript).toContain('  "acmebot": {');
  }, 120_000);
});

/** The wired Deps as ACME: its provider, and the adapters that name the provider (git's temp index, gates). */
function asAcme(deps: Deps): Deps {
  return {
    ...deps,
    provider: ACME_PROVIDER,
    git: createGitCli(ACME_PROVIDER.name),
    gates: createShellGates(ACME_PROVIDER.name),
  };
}

/** The same claude worker under ACME_WORKER's brief terms. */
function withTerms(worker: Worker): Worker {
  return {
    caps: { ...worker.caps, ...ACME_WORKER },
    preflight: () => worker.preflight(),
    start: (spec) => worker.start(spec),
    parseLine: (line) => worker.parseLine(line),
    dispose: () => worker.dispose(),
  };
}
