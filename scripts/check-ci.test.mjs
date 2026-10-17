import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));

test("the release runs its jobs on macOS and Linux only", () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const runner = String(job["runs-on"] ?? "ubuntu-");
    assert.ok(/^(ubuntu|macos)-/.test(runner), `job ${name} runs on ${runner}`);
  }
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  for (const step of steps) {
    for (const [, goos] of String(step.run ?? "").matchAll(/GOOS=(\w+)/g))
      assert.ok(goos === "darwin" || goos === "linux", `a step builds for ${goos}: ${step.name ?? step.run}`);
  }
});

test("every step pins its action by commit sha", () => {
  for (const step of Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])) {
    if (!step.uses || step.uses.startsWith("./")) continue;
    const [action, sha] = step.uses.split("@");
    assert.match(sha, /^[0-9a-f]{40}$/, `${action} must be pinned by commit sha`);
  }
});

test("the release runs only on a pushed v<VERSION> tag", () => {
  const on = workflow.on ?? {};
  assert.deepEqual(Object.keys(on), ["push"], "only a pushed tag releases");
  assert.deepEqual(on.push?.tags, ["v*"], "the tag is v<VERSION>");
  assert.equal(on.push?.branches, undefined, "a branch push never releases");
});

test("the release refuses a tag that does not name the committed VERSION and manifest", () => {
  const runs = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? "")
    .join("\n");
  for (const pin of ['"$TAG" != "v$version"', 'release/v$version.json', "go run ./scripts/build -check"]) {
    assert.ok(runs.includes(pin), `release.yml must contain: ${pin}`);
  }
  const publish = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((step) => (step.run ?? "").includes("scripts/releasenotes"));
  assert.ok(publish, "the release job must print its notes with releasenotes");
  assert.ok(publish.run.includes("dist/SHA256SUMS"), "the notes carry the checksums");
});

test("every release manifest lists the four macOS and Linux targets only", () => {
  const releaseDir = new URL("../packages/core/release/", import.meta.url);
  const names = readdirSync(releaseDir).filter((name) => /^v\d+\.\d+\.\d+\.json$/.test(name));
  assert.ok(names.length > 0, "no manifest found under packages/core/release");
  for (const name of names) {
    const manifest = JSON.parse(readFileSync(new URL(name, releaseDir), "utf8"));
    assert.deepEqual(
      Object.keys(manifest.assets),
      ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"],
      `${name} must list exactly the four targets`,
    );
    for (const [target, asset] of Object.entries(manifest.assets))
      assert.ok(asset.name.endsWith(`-${target}`), `${name}: ${asset.name} must end with -${target}`);
  }
});
