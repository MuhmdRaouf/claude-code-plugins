import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsStateDir, legacyStateDir, migrateStateDir } from "../../src/adapters/state-migrate.ts";
import { resolveStateRoot } from "../../src/adapters/state-root.ts";
import { routersHome } from "../../src/router/registry.ts";
import { radarHome } from "../../src/router/spool-write.ts";
import { tempDir } from "../support/tmp.ts";

/** A rule like zai's, under a name no other test uses. */
const RULE = { envVar: "ACME_STATE_DIR", dataPrefix: "acme-plugin-", xdgName: "acme" };

/** A world with HOME, XDG_STATE_HOME and an old state dir for `name` inside one temp dir. */
function world(
  name: string,
  entries: Record<string, string> = {},
): {
  home: string;
  xdg: string;
  old: string;
  fresh: string;
  env: Record<string, string>;
  log: (line: string) => void;
  lines: string[];
} {
  const home = tempDir("core-migrate-");
  const xdg = join(home, "xdg-state");
  const old = join(xdg, name);
  for (const [entry, content] of Object.entries(entries)) {
    const file = join(old, entry);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const lines: string[] = [];
  return {
    home,
    xdg,
    old,
    fresh: agentsStateDir({ HOME: home }, name),
    env: { HOME: home, XDG_STATE_HOME: xdg },
    log: (line) => lines.push(line),
    lines,
  };
}

describe("migrateStateDir", () => {
  it("a fresh install: no old dir, nothing created and nothing logged", () => {
    const w = world("acme");
    migrateStateDir("acme", w.env, w.log);
    expect(existsSync(join(w.home, ".agents"))).toBe(false);
    expect(w.lines).toEqual([]);
  });

  it("a full move: every entry lands in ~/.agents, the old dir is removed, the new dir keeps mode 0700", () => {
    const w = world("acme", { "ledger.json": "{}", "jobs/a": "job a" });
    mkdirSync(join(w.old, "router"), { recursive: true });
    writeFileSync(join(w.old, "router", "router.log"), "log\n");
    writeFileSync(join(w.home, "outside.txt"), "outside\n");
    symlinkSync(join(w.home, "outside.txt"), join(w.old, "latest-link"));

    migrateStateDir("acme", w.env, w.log);

    expect(readFileSync(join(w.fresh, "ledger.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(w.fresh, "jobs", "a"), "utf8")).toBe("job a");
    expect(readFileSync(join(w.fresh, "router", "router.log"), "utf8")).toBe("log\n");
    // A symlink moves as the link it is: still pointing out of the dir, whose target is never touched.
    expect(lstatSync(join(w.fresh, "latest-link")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(w.fresh, "latest-link"), "utf8")).toBe("outside\n");
    expect(readFileSync(join(w.home, "outside.txt"), "utf8")).toBe("outside\n");
    expect(existsSync(w.old)).toBe(false);
    expect((statSync(w.fresh).mode & 0o777).toString(8)).toBe("700");
    expect(w.lines).toEqual([]);
  });

  it("a partial move: an entry the new dir already has is left in the old dir, never overwritten", () => {
    const w = world("acme", { "ledger.json": "old ledger", "jobs/a": "job a" });
    mkdirSync(w.fresh, { recursive: true });
    writeFileSync(join(w.fresh, "ledger.json"), "new ledger");

    migrateStateDir("acme", w.env, w.log);

    expect(readFileSync(join(w.fresh, "ledger.json"), "utf8")).toBe("new ledger");
    expect(readFileSync(join(w.fresh, "jobs", "a"), "utf8")).toBe("job a");
    expect(readFileSync(join(w.old, "ledger.json"), "utf8")).toBe("old ledger");
    expect(existsSync(w.old)).toBe(true);
    expect(w.lines).toEqual([expect.stringContaining("ledger.json left in")]);
    expect(w.lines[0]).toContain(w.old);
  });

  it("a second run is a no-op: the old dir is gone, the moved state is untouched, nothing is logged", () => {
    const w = world("acme", { "ledger.json": "{}" });
    migrateStateDir("acme", w.env, w.log);
    migrateStateDir("acme", w.env, w.log);
    expect(readFileSync(join(w.fresh, "ledger.json"), "utf8")).toBe("{}");
    expect(existsSync(w.old)).toBe(false);
    expect(w.lines).toEqual([]);
  });

  it("a failed move keeps everything in the old dir, logs one line, and the next start retries it", () => {
    const w = world("acme", { "ledger.json": "{}", "jobs/a": "job a" });
    mkdirSync(w.fresh, { recursive: true });
    chmodSync(w.fresh, 0o500); // every rename into the new dir fails now
    try {
      migrateStateDir("acme", w.env, w.log);
      expect(w.lines).toHaveLength(1);
      expect(readFileSync(join(w.old, "ledger.json"), "utf8")).toBe("{}");
      expect(readFileSync(join(w.old, "jobs", "a"), "utf8")).toBe("job a");
    } finally {
      chmodSync(w.fresh, 0o700);
    }

    migrateStateDir("acme", w.env, w.log); // the next start moves what stayed behind
    expect(readFileSync(join(w.fresh, "ledger.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(w.fresh, "jobs", "a"), "utf8")).toBe("job a");
    expect(existsSync(w.old)).toBe(false);
    expect(w.lines).toHaveLength(1);
  });

  it("a new root that cannot be created leaves the old state alone and still logs one line", () => {
    const w = world("acme", { "ledger.json": "{}" });
    writeFileSync(join(w.home, ".agents"), "a file, not a dir");

    migrateStateDir("acme", w.env, w.log);

    expect(readFileSync(join(w.old, "ledger.json"), "utf8")).toBe("{}");
    expect(w.lines).toEqual([expect.stringContaining("cannot create")]);
  });

  it("without XDG_STATE_HOME the old dir is still found at ~/.local/state", () => {
    const home = tempDir("core-migrate-");
    const old = join(home, ".local", "state", "acme");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "ledger.json"), "{}");
    expect(legacyStateDir({ HOME: home }, "acme")).toBe(old);
    expect(agentsStateDir({ HOME: home }, "acme")).toBe(join(home, ".agents", "acme"));

    migrateStateDir("acme", { HOME: home });

    expect(readFileSync(join(home, ".agents", "acme", "ledger.json"), "utf8")).toBe("{}");
    expect(existsSync(old)).toBe(false);
  });
});

describe("the default roots migrate the old state once", () => {
  it("resolveStateRoot: ~/.agents/<name>, with XDG_STATE_HOME only where the migration looks for old state", () => {
    const w = world("acme", { "ledger.json": "{}" });
    expect(resolveStateRoot(w.env, RULE, w.log)).toBe(w.fresh);
    expect(readFileSync(join(w.fresh, "ledger.json"), "utf8")).toBe("{}");
    expect(existsSync(w.old)).toBe(false);
    expect(w.lines).toEqual([]);
  });

  it("an explicit env var or the plugin's own data dir skips the migration entirely", () => {
    const withEnv = world("acme", { "ledger.json": "{}" });
    expect(resolveStateRoot({ ...withEnv.env, ACME_STATE_DIR: "/explicit" }, RULE, withEnv.log)).toBe(
      "/explicit",
    );
    expect(existsSync(withEnv.fresh)).toBe(false);
    expect(existsSync(withEnv.old)).toBe(true);

    const withData = world("acme", { "ledger.json": "{}" });
    const data = "/data/acme-plugin-muhmdraouf";
    expect(resolveStateRoot({ ...withData.env, CLAUDE_PLUGIN_DATA: data }, RULE, withData.log)).toBe(data);
    expect(existsSync(withData.fresh)).toBe(false);
    expect(existsSync(withData.old)).toBe(true);
  });

  it("radarHome moves an old radar dir over; both homes' env overrides skip the migration", () => {
    const radar = world("radar", { port: "1234\n" });
    expect(radarHome(radar.env)).toBe(join(radar.home, ".agents", "radar"));
    expect(readFileSync(join(radar.home, ".agents", "radar", "port"), "utf8")).toBe("1234\n");
    expect(existsSync(radar.old)).toBe(false);
    expect(radarHome({ ...radar.env, RADAR_HOME: "/pin" })).toBe("/pin");

    const routers = world("provider-routers", { "zai.json": "{}\n" });
    expect(routersHome(routers.env, routers.log)).toBe(join(routers.home, ".agents", "provider-routers"));
    expect(readFileSync(join(routers.home, ".agents", "provider-routers", "zai.json"), "utf8")).toBe("{}\n");
    expect(routersHome({ ...routers.env, PROVIDER_ROUTERS_HOME: "/own" })).toBe("/own");
  });
});
