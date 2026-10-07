// The plugins' dist/run launcher: Bun when it is on PATH (or in Bun's install dir), else Node; with neither, a hook
// still exits 0 (silently) and anything else exits 127 with the reason.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build helper without types.
import { launcherScript } from "../../scripts/launcher.mjs";
import { tempDir } from "../support/tmp.ts";

/** A dist dir with the launcher and a bin dir holding fake runtimes that print their name and their arguments. */
function rig(runtimes: readonly string[]) {
  const dir = tempDir("launcher-");
  const dist = join(dir, "dist");
  const bin = join(dir, "bin");
  mkdirSync(dist);
  mkdirSync(bin);
  // The one external tool the launcher needs; /usr/bin itself may hold a node (some CI images), so it stays off PATH.
  const tools = join(dir, "tools");
  mkdirSync(tools);
  symlinkSync(
    spawnSync("/bin/sh", ["-c", "command -v dirname"], { encoding: "utf8" }).stdout.trim(),
    join(tools, "dirname"),
  );
  writeFileSync(join(dist, "run"), (launcherScript as (name: string) => string)("acme"));
  for (const name of runtimes) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const run = (args: readonly string[], env: Record<string, string> = {}) =>
    spawnSync("/bin/sh", [join(dist, "run"), ...args], {
      encoding: "utf8",
      env: { PATH: `${bin}:${tools}`, HOME: join(dir, "home"), ...env },
    });
  return { dir, dist, bin, run };
}

describe("dist/run", () => {
  it("prefers bun and passes the bundle and every argument through", () => {
    const { dist, run } = rig(["bun", "node"]);
    const result = run(["acme.js", "setup", "--hook", "a b"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`bun ${join(dist, "acme.js")} setup --hook a b\n`);
  });

  it("falls back to node when there is no bun", () => {
    const { dist, run } = rig(["node"]);
    expect(run(["acme.js", "board"]).stdout).toBe(`node ${join(dist, "acme.js")} board\n`);
  });

  it("finds bun in its install dir when it is not on PATH", () => {
    const { dir, dist, run } = rig(["node"]);
    const installed = join(dir, "bun-home");
    mkdirSync(join(installed, "bin"), { recursive: true });
    writeFileSync(join(installed, "bin", "bun"), '#!/bin/sh\necho installed-bun "$@"\n');
    chmodSync(join(installed, "bin", "bun"), 0o755);
    expect(run(["acme.js"], { BUN_INSTALL: installed }).stdout).toBe(
      `installed-bun ${join(dist, "acme.js")}\n`,
    );
  });

  it("with neither runtime: a hook exits 0 silently, anything else 127 saying why", () => {
    const { run } = rig([]);
    const hook = run(["acme-ensure.js", "--hook"]);
    expect({ status: hook.status, stdout: hook.stdout, stderr: hook.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    const command = run(["acme.js", "setup"]);
    expect(command.status).toBe(127);
    expect(command.stderr).toBe("acme: needs Bun 1.3 or newer (or Node 22 or newer) on PATH\n");
  });
});
