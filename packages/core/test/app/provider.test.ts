import { describe, expect, it } from "vitest";
import { accept } from "../../src/app/decide.ts";
import type { Deps } from "../../src/app/deps.ts";
import { drive } from "../../src/app/drive.ts";
import { ping } from "../../src/app/ping.ts";
import { submit } from "../../src/app/submit.ts";
import { err } from "../../src/domain/result.ts";
import { aChangeSet } from "../support/builders.ts";
import { completes, type Fakes, fakeDeps } from "../support/fakes.ts";
import { ACME_PROVIDER } from "../support/provider.ts";

function acme(fakes: Fakes): Deps {
  return { ...fakes.deps, provider: ACME_PROVIDER };
}

function brief(front: string): string {
  return `---\ntitle: Rename foo\n${front}\n---\nRename \`foo\` to \`bar\`.\n`;
}

// The use cases name branches, trailers, env and the pinged model after the provider they are given.
describe("use cases take every name from the provider", () => {
  it("submit puts an edit job on branch <branchPrefix><id>", async () => {
    const fakes = fakeDeps();

    const submitted = await submit(acme(fakes), { text: brief("mode: edit"), cwd: "/repo" });

    expect(submitted.ok && submitted.value.workspace.branch).toBe("acme-jobs/261006-job001");
    expect(fakes.git.called("addWorktree")[0]?.[2]).toBe("acme-jobs/261006-job001");
  });

  it("drive passes the artifacts dir under the provider's variable and writes the provider's contract footer", async () => {
    const fakes = fakeDeps();
    const submitted = await submit(acme(fakes), { text: brief("mode: exec\ngates: [ls]"), cwd: "/repo" });
    if (!submitted.ok) throw new Error("not submitted");
    const { id, workspace } = submitted.value;

    await drive(acme(fakes), id);

    const spec = fakes.worker.specs[0];
    expect(spec?.passEnv).toEqual({ ACME_OUT: workspace.artifactsDir });
    expect(fakes.gates.calls[0]?.passEnv).toEqual({ ACME_OUT: workspace.artifactsDir });
    expect(spec?.prompt).toContain("\n## acme contract\n");
    expect(spec?.prompt).toContain(
      `Write every output file to ${workspace.artifactsDir} (also in $ACME_OUT).`,
    );
    expect(spec?.prompt.replaceAll(workspace.artifactsDir, "<artifacts>")).not.toMatch(/zai/i);
  });

  it("accept commits with the trailer `Worked-by: <catalog id> via <harness>`", async () => {
    const fakes = fakeDeps();
    fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
    const submitted = await submit(acme(fakes), { text: brief("mode: edit"), cwd: "/repo" });
    if (!submitted.ok) throw new Error("not submitted");
    await drive(acme(fakes), submitted.value.id);

    await accept(acme(fakes), submitted.value.id, { mode: "commit", force: false, verify: true });

    expect(fakes.git.called("commitAll")[0]?.[1]).toBe(
      "Rename foo\n\nRenamed foo to bar\n\nWorked-by: big-model-9 via acme-harness\n",
    );
  });

  it("a worktree that cannot be removed is reported under the provider's name", async () => {
    const fakes = fakeDeps();
    fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
    const submitted = await submit(acme(fakes), { text: brief("mode: edit"), cwd: "/repo" });
    if (!submitted.ok) throw new Error("not submitted");
    await drive(acme(fakes), submitted.value.id);
    fakes.git.removeWorktreeResult = err({ kind: "git_failed", command: "git worktree", stderr: "busy" });

    await accept(acme(fakes), submitted.value.id, { mode: "commit", force: false, verify: true });

    expect(fakes.out.errors).toEqual([
      "acme: job 261006-job001 is accepted, but its worktree could not be removed: git worktree: busy",
    ]);
  });

  it("ping asks the provider's ping tier", async () => {
    const fakes = fakeDeps([completes({ summary: "pong", findings: [], open_items: [] })]);

    await ping(acme(fakes));

    expect(fakes.worker.specs[0]?.model.tier).toBe("main");
  });
});
