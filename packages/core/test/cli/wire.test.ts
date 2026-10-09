import { chmodSync, mkdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stateRoot } from "../../src/adapters/state-root.ts";
import { wire } from "../../src/cli/wire.ts";
import { DEFAULT_LIMITER } from "../../src/domain/limiter.ts";
import { RecordingOutput } from "../support/fakes.ts";
import { ACME_PROVIDER, REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";
import { until } from "../support/wait.ts";

const FAKE_CLAUDE = join(import.meta.dirname, "../support/fake-claude.ts");

/** A sandboxed environment: HOME points at a temp dir, so the key file lookup never reaches the real one. */
function sandbox(extra: Record<string, string> = {}): Record<string, string> {
  const home = tempDir("core-wire-");
  return { HOME: home, PATH: process.env.PATH ?? "", ZAI_STATE_DIR: join(home, "state"), ...extra };
}

describe("wire", () => {
  it("state root: the provider's env var, else its own $CLAUDE_PLUGIN_DATA, else ~/.agents", () => {
    const zaiData = "/home/me/.claude/plugins/data/zai-plugin-cc-muhmdraouf";
    expect(
      stateRoot(REFERENCE_PROVIDER, {
        ZAI_STATE_DIR: "/explicit",
        CLAUDE_PLUGIN_DATA: zaiData,
        HOME: "/home/me",
      }),
    ).toBe("/explicit");
    expect(
      stateRoot(REFERENCE_PROVIDER, {
        CLAUDE_PLUGIN_DATA: zaiData,
        XDG_STATE_HOME: "/xdg",
        HOME: "/home/me",
      }),
    ).toBe(zaiData);
    // XDG_STATE_HOME no longer picks the root; the migration looks there for old state instead.
    expect(stateRoot(REFERENCE_PROVIDER, { XDG_STATE_HOME: "/xdg", HOME: "/home/me" })).toBe(
      "/home/me/.agents/zai",
    );
    expect(stateRoot(REFERENCE_PROVIDER, { HOME: "/home/me" })).toBe("/home/me/.agents/zai");
    // The rule is the provider's own names, not zai's: acme keeps $ACME_STATE_DIR and ~/.agents/acme.
    expect(stateRoot(ACME_PROVIDER, { ZAI_STATE_DIR: "/explicit", HOME: "/home/me" })).toBe(
      "/home/me/.agents/acme",
    );
    expect(stateRoot(ACME_PROVIDER, { ACME_STATE_DIR: "/acme-explicit", HOME: "/home/me" })).toBe(
      "/acme-explicit",
    );
  });

  it("ignores a $CLAUDE_PLUGIN_DATA that belongs to another plugin (it leaks into every Bash tool call)", () => {
    for (const other of [
      "/home/me/.claude/plugins/data/grok-build-xai-grok-build",
      "/data",
      "/x/zaiplugin-y",
    ]) {
      expect(stateRoot(REFERENCE_PROVIDER, { CLAUDE_PLUGIN_DATA: other, HOME: "/home/me" })).toBe(
        "/home/me/.agents/zai",
      );
    }
  });

  it("the limiter config is the default whatever the env says: ZAI_MAX_CONCURRENCY caps via the limiter state submit writes", async () => {
    const deps = wire({
      provider: REFERENCE_PROVIDER,
      env: sandbox({ ZAI_MAX_CONCURRENCY: "3" }),
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });
    expect(deps.config.limiter).toEqual(DEFAULT_LIMITER);
    expect(await deps.limiter.limit(0)).toEqual({
      cap: DEFAULT_LIMITER.defaultMax,
      max: DEFAULT_LIMITER.defaultMax,
    });
  });

  it("creates the state root and its claude-home config dir mode 0700, tightening an existing one", () => {
    const env = sandbox();
    const root = env.ZAI_STATE_DIR ?? "";
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o755);

    const deps = wire({
      provider: REFERENCE_PROVIDER,
      env,
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });

    expect(deps.host.stateRoot).toBe(root);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "claude-home")).mode & 0o777).toBe(0o700);
    expect(deps.config.stopGraceMs).toBe(10_000);
  });

  it("env overrides reach the jobs' catalog and endpoint, never the plugin's own names", () => {
    const asShipped = wire({
      provider: REFERENCE_PROVIDER,
      env: sandbox(),
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });
    const overridden = wire({
      provider: REFERENCE_PROVIDER,
      env: sandbox({
        ZAI_MODEL_MAIN: "glm-5.5",
        ZAI_MODEL_FLASH: "glm-5.5-flash",
        ZAI_BASE_URL: "https://override.example/api/anthropic",
      }),
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });

    expect(asShipped.provider.catalog.main.id).toBe("glm-5.3");
    expect(asShipped.provider.baseUrl).toBe("https://api.z.ai/api/anthropic");
    expect(overridden.provider.catalog.main.id).toBe("glm-5.5");
    expect(overridden.provider.catalog.flash.id).toBe("glm-5.5-flash");
    expect(overridden.provider.baseUrl).toBe("https://override.example/api/anthropic");
    expect(overridden.provider.name).toBe("zai");
    expect(overridden.provider.agents).toEqual({ main: "glm-5.3", flash: "glm-5.3-flash" });
  });

  it("host reports the worker binary's version, or why it cannot run", async () => {
    const working = wire({
      provider: REFERENCE_PROVIDER,
      env: sandbox({ ZAI_CLAUDE_BIN: FAKE_CLAUDE }),
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });
    const missing = wire({
      provider: REFERENCE_PROVIDER,
      env: sandbox({ ZAI_CLAUDE_BIN: "/nonexistent/claude" }),
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });

    expect(working.host.workerBin).toBe(FAKE_CLAUDE);
    expect(await working.host.workerVersion()).toEqual({ ok: true, value: "2.1.289 (Claude Code, fake)" });
    expect(await missing.host.workerVersion()).toEqual({
      ok: false,
      error: expect.stringContaining("ENOENT"),
    });
    expect(
      wire({
        provider: REFERENCE_PROVIDER,
        env: sandbox(),
        bundlePath: "/zai.js",
        out: new RecordingOutput(),
      }).host.workerBin,
    ).toBe("claude");
    // The binary's env name is the provider's own prefix, not zai's.
    expect(
      wire({
        provider: ACME_PROVIDER,
        env: sandbox({ ACME_CLAUDE_BIN: FAKE_CLAUDE }),
        bundlePath: "/acme.js",
        out: new RecordingOutput(),
      }).host.workerBin,
    ).toBe(FAKE_CLAUDE);
  });

  it("key source names the env var or the key file, never the key; no key is the loader's error", async () => {
    const fromEnv = wire({
      provider: REFERENCE_PROVIDER,
      env: sandbox({ ZAI_API_KEY: "sk-zai-secret" }),
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });
    const none = wire({
      provider: REFERENCE_PROVIDER,
      env: sandbox(),
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });

    expect(await fromEnv.host.extraChecks()).toEqual([
      { label: "key", result: { ok: true, value: "ZAI_API_KEY" }, text: "present (ZAI_API_KEY)" },
    ]);
    expect(await none.host.extraChecks()).toEqual([
      {
        label: "key",
        result: { ok: false, error: expect.stringContaining("no Z.ai GLM key: export ZAI_API_KEY") },
        text: expect.stringContaining("MISSING: no Z.ai GLM key: export ZAI_API_KEY"),
      },
    ]);
  });

  it("host.loadKey resolves through the same loader as the worker: env key, else the key file, else the error", async () => {
    const fromEnv = wire({
      provider: REFERENCE_PROVIDER,
      env: sandbox({ ZAI_API_KEY: "sk-zai-secret" }),
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });
    const loaded = await fromEnv.host.loadKey();

    expect(loaded.ok && loaded.value.source).toBe("ZAI_API_KEY");
    expect(loaded).toMatchObject({ ok: true, value: { value: "sk-zai-secret" } });
    expect(
      (
        await wire({
          provider: REFERENCE_PROVIDER,
          env: sandbox(),
          bundlePath: "/zai.js",
          out: new RecordingOutput(),
        }).host.loadKey()
      ).ok,
    ).toBe(false);
  });

  // The router bundle (/zai-router.js) is not there and the pinned port has nothing on it: copying it fails (ENOENT),
  // and so does the emergency passthrough beside it, so the start reports both.
  it("host.ensureRouter reports the start failure, without leaving the sandbox", async () => {
    const deps = wire({
      provider: REFERENCE_PROVIDER,
      env: sandbox({ ZAI_ROUTER_PORT: "18999" }),
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });
    const result = await deps.host.ensureRouter();

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/ENOENT/) });
  });

  it("passes the output port and the environment through", () => {
    const out = new RecordingOutput();
    const deps = wire({ provider: REFERENCE_PROVIDER, env: sandbox(), bundlePath: "/zai.js", out });

    deps.out.line("hello");

    expect(out.lines).toEqual(["hello"]);
    expect(deps.env.ZAI_STATE_DIR).toBe(deps.host.stateRoot);
  });

  it("spawnDriver runs the given bundle as `drive <id>` with its log in the job's dir", async () => {
    const bundle = join(tempDir("core-driver-"), "driver.mjs");
    await writeFile(bundle, 'console.log("driver up");\n');
    const deps = wire({
      provider: REFERENCE_PROVIDER,
      env: sandbox(),
      bundlePath: bundle,
      out: new RecordingOutput(),
    });
    const id = deps.ids.jobId();

    const pid = deps.process.spawnDriver(id);
    await until(() => !deps.process.isAlive(pid), { message: "the driver did not exit" });

    expect((await readFile(join(deps.store.paths(id).dir, "driver.log"), "utf8")).trim()).toBe("driver up");
  });
});
