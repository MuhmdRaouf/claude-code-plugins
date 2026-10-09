import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { providerStateDir, stateDir } from "../src/shared/paths.ts";
import { migrateStateDir } from "../src/shared/state-migrate.ts";

/** A HOME whose old ~/.local/state/<name> holds `entries` ("<name>/<file>" → content), removed with the test. */
function home(entries: Record<string, string> = {}): string {
  const dir = join(tmpdir(), `radar-migrate-${Math.random().toString(36).slice(2)}`);
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(entries)) {
    const file = join(dir, ".local", "state", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

describe("stateDir and providerStateDir move the old state over", () => {
  it("a fresh install: no old dir, nothing extra created", () => {
    const dir = home();
    expect(stateDir({ HOME: dir })).toBe(join(dir, ".agents", "radar"));
    expect(existsSync(join(dir, ".agents"))).toBe(false);
  });

  it("a full move: the old radar dir lands in ~/.agents/radar and is removed", () => {
    const dir = home({ "radar/port": "1234\n" });
    expect(stateDir({ HOME: dir })).toBe(join(dir, ".agents", "radar"));
    expect(readFileSync(join(dir, ".agents", "radar", "port"), "utf8")).toBe("1234\n");
    expect(existsSync(join(dir, ".local", "state", "radar"))).toBe(false);
  });

  it("a partial move: jobs the new place already has stay behind and are never overwritten", () => {
    const dir = home({ "zai/jobs/old/job.json": "{}" });
    mkdirSync(join(dir, ".agents", "zai", "jobs", "kept"), { recursive: true });
    writeFileSync(join(dir, ".agents", "zai", "jobs", "kept", "job.json"), "{}");
    expect(providerStateDir({ HOME: dir }, "zai")).toBe(join(dir, ".agents", "zai"));
    expect(existsSync(join(dir, ".agents", "zai", "jobs", "kept", "job.json"))).toBe(true);
    expect(existsSync(join(dir, ".local", "state", "zai", "jobs", "old", "job.json"))).toBe(true);
  });

  it("a failed move keeps the old state and logs one line; the env overrides skip the migration", () => {
    const dir = home({ "radar/port": "1234\n" });
    mkdirSync(join(dir, ".agents"));
    writeFileSync(join(dir, ".agents", "radar"), "a file where the dir must go");
    const lines: string[] = [];
    migrateStateDir("radar", { HOME: dir }, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(readFileSync(join(dir, ".local", "state", "radar", "port"), "utf8")).toBe("1234\n");

    // An override means no migration is even attempted.
    expect(stateDir({ HOME: dir, RADAR_HOME: "/pin" })).toBe("/pin");
    expect(providerStateDir({ HOME: dir, ZAI_STATE_DIR: "/own" }, "zai")).toBe("/own");
    expect(existsSync(join(dir, ".local", "state", "radar", "port"))).toBe(true);
  });
});
