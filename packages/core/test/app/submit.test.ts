import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { submit } from "../../src/app/submit.ts";
import { err } from "../../src/domain/result.ts";
import { BASE_SHA, fakeDeps } from "../support/fakes.ts";

function brief(front: string, body = "Rename `foo` to `bar`.\n"): string {
  return `---\n${front}\n---\n${body}`;
}

const EDIT = brief("title: Rename foo\ngates: [npm test]");

describe("submit", () => {
  it("edit: creates worktree zai/<id> at the resolved base sha and persists a queued job", async () => {
    const { deps, git, store, root } = fakeDeps();

    const submitted = await submit(deps, {
      text: EDIT,
      sourcePath: "/repo/briefs/rename.md",
      cwd: "/repo/src",
    });

    const id = "261006-job001";
    const worktree = join(root, "worktrees", id);
    expect(git.called("addWorktree")).toEqual([["/repo", worktree, `zai/${id}`, BASE_SHA]]);
    expect(submitted).toEqual({ ok: true, value: store.jobs.get(id) });
    expect(store.jobs.get(id)).toMatchObject({
      id,
      state: "queued",
      attempts: [],
      version: 1,
      createdAt: "2026-10-06T00:00:00.000Z",
      updatedAt: "2026-10-06T00:00:00.000Z",
      brief: { title: "Rename foo", mode: "edit", model: "main", cwd: "/repo", base: "HEAD" },
      workspace: {
        repoRoot: "/repo",
        baseSha: BASE_SHA,
        worktree,
        branch: `zai/${id}`,
        artifactsDir: join(root, "jobs", id, "artifacts"),
      },
    });
    expect(existsSync(join(root, "jobs", id, "artifacts"))).toBe(true);
    expect(readFileSync(join(root, "jobs", id, "brief.md"), "utf8")).toBe(EDIT);
  });

  it("exec/readonly: no worktree; workspace has repoRoot, baseSha and artifactsDir", async () => {
    const { deps, git, root } = fakeDeps();

    const exec = await submit(deps, { text: brief("title: Sweep\nmode: exec"), cwd: "/repo" });
    const readonly = await submit(deps, { text: brief("title: Read\nmode: readonly"), cwd: "/repo" });

    expect(git.called("addWorktree")).toEqual([]);
    expect(exec.ok && exec.value.workspace).toEqual({
      repoRoot: "/repo",
      baseSha: BASE_SHA,
      artifactsDir: join(root, "jobs", "261006-job001", "artifacts"),
    });
    expect(readonly.ok && readonly.value.brief.mode).toBe("readonly");
    expect(readonly.ok && readonly.value.workspace).not.toHaveProperty("worktree");
  });

  it("brief errors → brief error, nothing created", async () => {
    const { deps, git, store } = fakeDeps();

    const result = await submit(deps, { text: brief("mode: edit", "   \n"), cwd: "/repo" });

    expect(result).toEqual(
      err({
        kind: "brief",
        errors: [{ kind: "field", field: "title", message: "required" }, { kind: "empty_body" }],
      }),
    );
    expect(store.jobs.size).toBe(0);
    expect(git.called("addWorktree")).toEqual([]);
  });

  it("missing env names → missing_env listing all of them, nothing created", async () => {
    const { deps, store } = fakeDeps(undefined, { NPM_TOKEN: "secret", EMPTY: "" });

    const result = await submit(deps, {
      text: brief("title: Needs env\nenv: [NPM_TOKEN, EMPTY, GH_TOKEN, AWS_PROFILE]"),
      cwd: "/repo",
    });

    expect(result).toEqual(err({ kind: "missing_env", names: ["GH_TOKEN", "AWS_PROFILE"] }));
    expect(store.jobs.size).toBe(0);
  });

  it("applies --flash / --mode overrides before mode-dependent defaults", async () => {
    const { deps } = fakeDeps();

    const flashExec = await submit(deps, {
      text: brief("title: Sweep\nmodel: glm"),
      cwd: "/repo",
      overrides: { model: "flash", mode: "exec" },
    });
    const readonly = await submit(deps, {
      text: brief("title: Look\nmode: edit"),
      cwd: "/repo",
      overrides: { mode: "readonly" },
    });

    expect(flashExec.ok && flashExec.value.brief).toMatchObject({
      model: "flash",
      mode: "exec",
      scope: [],
      report: { kind: "builtin", name: "sweep" },
    });
    expect(readonly.ok && readonly.value.brief).toMatchObject({
      model: "flash",
      mode: "readonly",
      report: { kind: "builtin", name: "notes" },
    });
  });

  it("store failure after worktree creation removes the worktree again", async () => {
    const { deps, git, store, root } = fakeDeps();
    store.failCreate = { kind: "io", message: "disk full" };

    const result = await submit(deps, { text: EDIT, cwd: "/repo" });

    const id = "261006-job001";
    expect(result).toEqual(err({ kind: "store", error: { kind: "io", message: "disk full" } }));
    expect(git.called("removeWorktree")).toEqual([["/repo", join(root, "worktrees", id), `zai/${id}`]]);
  });

  it("outside a repository, or with an unknown base, fails with the git error before creating anything", async () => {
    const { deps, git, store } = fakeDeps();

    const outside = await submit(deps, { text: EDIT, cwd: "/elsewhere" });
    const badBase = await submit(deps, { text: brief("title: Old\nbase: missing"), cwd: "/repo" });

    expect(outside).toEqual(err({ kind: "git", error: { kind: "not_a_repo", path: "/elsewhere" } }));
    expect(badBase).toEqual(err({ kind: "git", error: { kind: "bad_ref", ref: "missing" } }));
    expect(store.jobs.size).toBe(0);
    expect(git.called("addWorktree")).toEqual([]);
  });

  it("a worktree that cannot be created fails the submit with nothing persisted", async () => {
    const { deps, git, store } = fakeDeps();
    git.addWorktreeResult = err({ kind: "git_failed", command: "git worktree add", stderr: "exists" });

    const result = await submit(deps, { text: EDIT, cwd: "/repo" });

    expect(result).toEqual(
      err({ kind: "git", error: { kind: "git_failed", command: "git worktree add", stderr: "exists" } }),
    );
    expect(store.jobs.size).toBe(0);
  });

  it("a report schema file must exist and hold a JSON object", async () => {
    const { deps, root } = fakeDeps();
    const schema = join(root, "schema.json");
    writeFileSync(schema, '{"type": "object"}');
    const notObject = join(root, "list.json");
    writeFileSync(notObject, "[1]");

    const good = await submit(deps, { text: brief(`title: Custom\nreport: ${schema}`), cwd: "/repo" });
    const missing = await submit(deps, {
      text: brief(`title: Custom\nreport: ${root}/nope.json`),
      cwd: "/repo",
    });
    const wrong = await submit(deps, { text: brief(`title: Custom\nreport: ${notObject}`), cwd: "/repo" });

    expect(good.ok).toBe(true);
    expect(missing).toMatchObject(err({ kind: "brief", errors: [{ kind: "field", field: "report" }] }));
    expect(wrong).toEqual(
      err({
        kind: "brief",
        errors: [{ kind: "field", field: "report", message: `${notObject} must hold a JSON schema object` }],
      }),
    );
  });
});
