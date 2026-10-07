import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildWorkerEnv,
  CLAUDE_CAPS,
  CLAUDE_ENV_DENYLIST,
  type ClaudeHeadlessOptions,
  ClaudeHeadlessWorker,
  claudeSessionMissing,
  pickClaudeSettings,
} from "../../src/adapters/claude-headless.ts";
import { ENV_ALLOWLIST } from "../../src/adapters/env.ts";
import { isAlive } from "../../src/adapters/process/group.ts";
import { checkReport } from "../../src/domain/reports.ts";
import { err, ok, type Result } from "../../src/domain/result.ts";
import type { WorkerEvent } from "../../src/domain/worker-events.ts";
import type { ReportContract, WorkerRun, WorkerSpec } from "../../src/ports/index.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";

function report(jsonSchema: Record<string, unknown>): ReportContract {
  return { name: "custom.json", jsonSchema, validate: (value) => checkReport(value, { kind: "file" }) };
}

function spec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    cwd: "/work/repo",
    model: REFERENCE_PROVIDER.catalog.main,
    access: "write",
    prompt: "Rename foo to bar everywhere.",
    session: { kind: "new", key: SESSION },
    report: report({ type: "object", properties: { summary: { type: "string" } } }),
    addDirs: [],
    passEnv: {},
    timeoutMs: 60_000,
    logPath: "/tmp/zai-test/attempt-1.jsonl",
    ...overrides,
  };
}

const KEY = "zai-test-key-0123456789abcdef";
/** The loader's result for KEY: the value plus where it came from. */
const LOADED_KEY = ok({ value: KEY, source: "ZAI_API_KEY" });
const CONFIG_DIR = "/state/claude-home";

/** A realistic orchestrator environment: allowlisted basics plus everything that must never reach a worker. */
const PARENT_ENV: Readonly<Record<string, string | undefined>> = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/dev",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm-256color",
  SHELL: "/bin/zsh",
  TMPDIR: "/tmp/dev",
  USER: "dev",
  LOGNAME: "dev",
  ANTHROPIC_API_KEY: "sk-ant-orchestrator-secret",
  ANTHROPIC_AUTH_TOKEN: "orchestrator-oauth-token",
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  ANTHROPIC_MODEL: "claude-opus",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CONFIG_DIR: "/home/dev/.claude",
  CLAUDE_PLUGIN_ROOT: "/home/dev/.claude/plugins/zai",
  ZAI_API_KEY: KEY,
  ZAI_MAX_CONCURRENCY: "3",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "gh-secret",
};

/** The value following `flag` in argv, or undefined. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe("buildClaudeArgs", () => {
  it("always: -p, --output-format stream-json, --verbose, --include-partial-messages, --model per tier", () => {
    const glm = buildClaudeArgs(spec());

    expect(glm.slice(0, 5)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ]);
    expect(flagValue(glm, "--model")).toBe("sonnet");
    // flash passes its full id, not the haiku alias: plan mode (readonly) resolves that alias to sonnet, i.e. the
    // main model.
    for (const access of ["write", "exec", "readonly"] as const) {
      expect(
        flagValue(buildClaudeArgs(spec({ model: REFERENCE_PROVIDER.catalog.flash, access })), "--model"),
      ).toBe(REFERENCE_PROVIDER.catalog.flash.id);
    }
  });
  it("new session → --session-id <id>; resume → --resume <id> (never both)", () => {
    const fresh = buildClaudeArgs(spec({ session: { kind: "new", key: SESSION } }));
    const resumed = buildClaudeArgs(spec({ session: { kind: "resume", key: SESSION } }));

    expect(flagValue(fresh, "--session-id")).toBe(SESSION);
    expect(fresh).not.toContain("--resume");
    expect(flagValue(resumed, "--resume")).toBe(SESSION);
    expect(resumed).not.toContain("--session-id");
  });
  it("--permission-mode from spec; --json-schema as compact JSON", () => {
    const schema = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };
    const bypass = buildClaudeArgs(spec({ report: report(schema) }));
    const plan = buildClaudeArgs(spec({ access: "readonly" }));

    expect(flagValue(bypass, "--permission-mode")).toBe("bypassPermissions");
    expect(flagValue(plan, "--permission-mode")).toBe("plan");
    expect(flagValue(bypass, "--json-schema")).toBe(
      '{"type":"object","required":["summary"],"properties":{"summary":{"type":"string"}}}',
    );
  });
  it("--effort only when set; --max-budget-usd only when set; one --add-dir per dir", () => {
    const bare = buildClaudeArgs(spec());
    const full = buildClaudeArgs(spec({ effort: "high", budgetUsd: 2.5, addDirs: ["/docs/a", "/docs/b"] }));

    expect(bare).not.toContain("--effort");
    expect(bare).not.toContain("--max-budget-usd");
    expect(bare).not.toContain("--add-dir");
    expect(flagValue(full, "--effort")).toBe("high");
    expect(flagValue(buildClaudeArgs(spec({ effort: "max" })), "--effort")).toBe("max");
    expect(flagValue(full, "--max-budget-usd")).toBe("2.5");
    expect(full.slice(-4)).toEqual(["--add-dir", "/docs/a", "--add-dir", "/docs/b"]);
  });
  it("never contains the prompt or any env value", () => {
    const prompt = "PROMPT-MARKER do the work";
    const args = buildClaudeArgs(
      spec({
        prompt,
        passEnv: { NPM_TOKEN: "env-value-marker" },
        effort: "low",
        addDirs: ["/x"],
        budgetUsd: 1,
      }),
    );

    const joined = args.join("\n");
    expect(joined).not.toContain("PROMPT-MARKER");
    expect(joined).not.toContain("env-value-marker");
  });
});

describe("the claude worker's port", () => {
  it("each access maps to a permission mode: write and exec bypass permissions, readonly plans", () => {
    const modes = (["write", "exec", "readonly"] as const).map((access) =>
      flagValue(buildClaudeArgs(spec({ access })), "--permission-mode"),
    );

    expect(modes).toEqual(["bypassPermissions", "bypassPermissions", "plan"]);
  });
  it("a session is missing only when a resume is answered with Claude Code's no-conversation line", () => {
    const tail = `No conversation found with session ID: ${SESSION}\n`;

    expect(claudeSessionMissing({ kind: "resume", key: SESSION }, tail)).toBe(true);
    expect(claudeSessionMissing({ kind: "new", key: SESSION }, tail)).toBe(false);
    expect(claudeSessionMissing({ kind: "resume", key: SESSION }, "fake claude: simulated crash\n")).toBe(
      false,
    );
  });
  it("caps: native schema, a budget, three efforts; the brief template names the claude flags", () => {
    const worker = new ClaudeHeadlessWorker({
      provider: REFERENCE_PROVIDER,
      bin: "claude",
      configDir: CONFIG_DIR,
      loadKey: async () => LOADED_KEY,
      parentEnv: {},
      stopGraceMs: 5_000,
    });

    expect(worker.caps).toBe(CLAUDE_CAPS);
    expect(worker.caps).toMatchObject({
      name: "claude-headless",
      nativeSchema: true,
      budget: true,
      efforts: ["low", "high", "max"],
      briefNotes: {
        effort: "passed to claude --effort",
        addDirs: "passed as --add-dir",
        budgetUsd: "passed as --max-budget-usd",
        readonly: "plan mode, read tools only",
      },
    });
  });
  it("preflight checks only the key: ok when it loads, the loader's error otherwise", async () => {
    const options = {
      provider: REFERENCE_PROVIDER,
      bin: "/no/such/claude",
      configDir: CONFIG_DIR,
      parentEnv: {},
      stopGraceMs: 5_000,
    };
    const keyed = new ClaudeHeadlessWorker({ ...options, loadKey: async () => LOADED_KEY });
    const keyless = new ClaudeHeadlessWorker({
      ...options,
      loadKey: async () => err({ kind: "no_key", message: "no key" }),
    });

    expect(await keyed.preflight()).toEqual({ ok: true, value: undefined });
    expect(await keyless.preflight()).toEqual({
      ok: false,
      error: { kind: "no_key", message: "no key" },
    });
  });
  it("parseLine reads stream-json lines; one it cannot read yields no events; dispose has nothing to release", async () => {
    const worker = new ClaudeHeadlessWorker({
      provider: REFERENCE_PROVIDER,
      bin: "claude",
      configDir: CONFIG_DIR,
      loadKey: async () => LOADED_KEY,
      parentEnv: {},
      stopGraceMs: 5_000,
    });

    expect(
      worker.parseLine('{"type":"system","subtype":"init","session_id":"s1","model":"glm-5.3"}'),
    ).toEqual([{ type: "init", sessionId: "s1", model: "glm-5.3" }]);
    expect(worker.parseLine("{not json")).toEqual([]);
    await expect(worker.dispose()).resolves.toBeUndefined();
  });
});

describe("buildWorkerEnv", () => {
  it("copies only ENV_ALLOWLIST names from the parent", () => {
    const env = buildWorkerEnv(REFERENCE_PROVIDER, spec(), KEY, PARENT_ENV, CONFIG_DIR);

    const withoutLcAll = buildWorkerEnv(
      REFERENCE_PROVIDER,
      spec(),
      KEY,
      { ...PARENT_ENV, LC_ALL: undefined },
      CONFIG_DIR,
    );

    for (const name of ENV_ALLOWLIST) expect(env[name]).toBe(PARENT_ENV[name]);
    expect(withoutLcAll).not.toHaveProperty("LC_ALL");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("ZAI_MAX_CONCURRENCY");
  });
  it("ENV_ALLOWLIST — all a gate process inherits from the parent — still contains no CLAUDE_* name", () => {
    for (const name of ENV_ALLOWLIST) expect(name.startsWith("CLAUDE")).toBe(false);
  });
  it("drops ANTHROPIC_API_KEY, the orchestrator's ANTHROPIC_AUTH_TOKEN, denied CLAUDE_* and plugin variables", () => {
    const env = buildWorkerEnv(REFERENCE_PROVIDER, spec(), KEY, PARENT_ENV, CONFIG_DIR);

    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_MODEL");
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env).not.toHaveProperty("CLAUDE_PLUGIN_ROOT");
    expect(env).not.toHaveProperty("ZAI_API_KEY");
    expect(env).not.toHaveProperty("ZAI_MAX_CONCURRENCY");
    const values = Object.values(env);
    for (const leaked of [
      "sk-ant-orchestrator-secret",
      "orchestrator-oauth-token",
      "https://api.anthropic.com",
    ]) {
      expect(values).not.toContain(leaked);
    }
    expect(values).not.toContain("/home/dev/.claude");
  });
  it("sets ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN=<key>, the alias mapping, API_TIMEOUT_MS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", () => {
    const env = buildWorkerEnv(REFERENCE_PROVIDER, spec(), KEY, PARENT_ENV, CONFIG_DIR);

    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flash",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  });
  it("sets CLAUDE_CONFIG_DIR to the isolated dir", () => {
    const env = buildWorkerEnv(REFERENCE_PROVIDER, spec(), KEY, PARENT_ENV, CONFIG_DIR);

    expect(env.CLAUDE_CONFIG_DIR).toBe(CONFIG_DIR);
  });
  it("passes the parent's CLAUDE_* settings through; an unset one stays unset (nothing is defaulted)", () => {
    const parent = {
      ...PARENT_ENV,
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "40",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
    };

    const env = buildWorkerEnv(REFERENCE_PROVIDER, spec(), KEY, parent, CONFIG_DIR);
    const unset = buildWorkerEnv(
      REFERENCE_PROVIDER,
      spec(),
      KEY,
      { ...parent, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: undefined },
      CONFIG_DIR,
    );

    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("40");
    // TOKENS is a size setting, not a credential: the credential rule matches TOKEN as a whole segment only.
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("32000");
    expect(unset).not.toHaveProperty("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE");
  });
  it("drops credential-shaped CLAUDE_* names: TOKEN, KEY or SECRET as a whole _ segment", () => {
    const credentials = {
      CLAUDE_CODE_API_TOKEN: "cred-token-marker",
      CLAUDE_CODE_TOKEN_FILE: "cred-token-marker",
      CLAUDE_CODE_API_KEY: "cred-key-marker",
      CLAUDE_CODE_KEY_FILE: "cred-key-marker",
      CLAUDE_CODE_CLIENT_SECRET: "cred-secret-marker",
      CLAUDE_CODE_SECRET_FILE: "cred-secret-marker",
    };

    const env = buildWorkerEnv(
      REFERENCE_PROVIDER,
      spec(),
      KEY,
      { ...PARENT_ENV, ...credentials },
      CONFIG_DIR,
    );

    const values = Object.values(env);
    for (const [name, value] of Object.entries(credentials)) {
      expect(env).not.toHaveProperty(name);
      expect(values).not.toContain(value);
    }
  });
  it("drops every CLAUDE_ENV_DENYLIST name from the parent; the plugin's own values still win", () => {
    // A trailing * entry denies its prefix, so plant a name under it. CLAUDE_CONFIG_DIR and
    // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC are denied yet present, with zai's values.
    const planted = CLAUDE_ENV_DENYLIST.map((entry) =>
      entry.endsWith("*") ? `${entry.slice(0, -1)}RESUMED` : entry,
    );
    const parent = { ...PARENT_ENV, ...Object.fromEntries(planted.map((name) => [name, `parent-${name}`])) };

    const env = buildWorkerEnv(REFERENCE_PROVIDER, spec(), KEY, parent, CONFIG_DIR);

    const values = Object.values(env);
    const pluginOwned = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]);
    for (const name of planted) {
      expect(values).not.toContain(`parent-${name}`);
      if (!pluginOwned.has(name)) expect(env).not.toHaveProperty(name);
    }
    expect(env.CLAUDE_CONFIG_DIR).toBe(CONFIG_DIR);
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });
  it("brief env may name CLAUDE_* settings (overriding the parent); denied ones and the reserved names are dropped", () => {
    const passEnv = {
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "25",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_SESSION_RESUMED: "orchestrator-session",
      CLAUDECODE: "1",
      ANTHROPIC_API_KEY: "sk-ant-orchestrator-secret",
      API_TIMEOUT_MS: "1",
      ZAI_API_KEY: KEY,
    };
    const parent = { ...PARENT_ENV, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "40" };

    const env = buildWorkerEnv(REFERENCE_PROVIDER, spec({ passEnv }), KEY, parent, CONFIG_DIR);

    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("25");
    expect(env).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK");
    expect(env).not.toHaveProperty("CLAUDE_CODE_SESSION_RESUMED");
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env.API_TIMEOUT_MS).toBe("3000000");
    expect(env).not.toHaveProperty("ZAI_API_KEY");
  });
  it("layers parent CLAUDE_* settings over the allowlist and passEnv over those (zai's own values come last)", () => {
    const passEnv = {
      NPM_TOKEN: "npm-value",
      PATH: "/opt/tools/bin:/usr/bin",
      ANTHROPIC_BASE_URL: "https://evil.example",
      ANTHROPIC_AUTH_TOKEN: "other-token",
      ANTHROPIC_API_KEY: "sk-ant-orchestrator-secret",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet",
      API_TIMEOUT_MS: "1",
      CLAUDE_CONFIG_DIR: "/home/dev/.claude",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
      CLAUDECODE: "1",
      ZAI_API_KEY: KEY,
      ZAI_ARTIFACTS: "/state/jobs/x/artifacts",
    };
    const parent = { ...PARENT_ENV, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "40" };

    const env = buildWorkerEnv(REFERENCE_PROVIDER, spec({ passEnv }), KEY, parent, CONFIG_DIR);

    expect(env).toEqual({
      PATH: "/opt/tools/bin:/usr/bin",
      HOME: "/home/dev",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp/dev",
      USER: "dev",
      LOGNAME: "dev",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "40",
      NPM_TOKEN: "npm-value",
      ZAI_ARTIFACTS: "/state/jobs/x/artifacts",
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flash",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: CONFIG_DIR,
    });
  });
});

const FAKE_CLAUDE = join(import.meta.dirname, "../support/fake-claude.ts");
const FIXTURE_429 = join(import.meta.dirname, "../fixtures/stream/rate-limited-429.jsonl");

/** Stand-in for domain/stream-parse.ts parseStreamLine: just enough to observe the worker's plumbing on its own. Everything
 *  it does not know becomes `other`, like the real parser; a `{"type":"pair"}` line yields two events. */
function stubParse(line: string): Result<readonly WorkerEvent[], string> {
  if (line.trim() === "") return ok([]);
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return err("malformed JSON");
  }
  if (!isRecord(event)) return ok([{ type: "other", raw: line }]);
  if (event.type === "pair") {
    return ok([
      { type: "assistant_text", text: "first" },
      { type: "tool_use", name: "Bash", summary: "second" },
    ]);
  }
  if (event.type === "system" && event.subtype === "init") {
    return ok([{ type: "init", sessionId: String(event.session_id), model: String(event.model) }]);
  }
  if (event.type === "assistant" && isRecord(event.message) && Array.isArray(event.message.content)) {
    const blocks: unknown[] = event.message.content;
    const text = blocks
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .join("");
    return ok([{ type: "assistant_text", text }]);
  }
  return ok([{ type: "other", raw: line }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function collect(run: WorkerRun): Promise<WorkerEvent[]> {
  const events: WorkerEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

describe("ClaudeHeadlessWorker (integration, fake claude)", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "core-worker-"));
  });
  afterEach(async () => {
    killLeftovers();
    await rm(dir, { recursive: true, force: true });
  });

  /** Groups whose pids a test learned, so a failing test cannot leak processes. */
  const groups: number[] = [];

  function killLeftovers(): void {
    for (const pid of groups.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone: the expected case
      }
    }
  }

  /** Waits for the fake to report "<its pid> <grandchild pid>" (FAKE_CLAUDE_PIDFILE). */
  async function groupPids(pidFile: string): Promise<readonly number[]> {
    for (;;) {
      const content = await readFile(pidFile, "utf8").catch(() => "");
      if (content !== "") {
        const pids = content.split(" ").map(Number);
        groups.push(pids[0] ?? -1);
        return pids;
      }
      await delay(20);
    }
  }

  function worker(overrides: Partial<ClaudeHeadlessOptions> = {}): ClaudeHeadlessWorker {
    return new ClaudeHeadlessWorker({
      provider: REFERENCE_PROVIDER,
      bin: FAKE_CLAUDE,
      configDir: join(dir, "claude-home"),
      loadKey: async () => LOADED_KEY,
      parentEnv: { ...PARENT_ENV, PATH: process.env.PATH },
      stopGraceMs: 5_000,
      parse: stubParse,
      ...overrides,
    });
  }

  function fakeSpec(passEnv: Record<string, string>, overrides: Partial<WorkerSpec> = {}): WorkerSpec {
    return spec({ cwd: dir, logPath: join(dir, "logs", "attempt-1.jsonl"), passEnv, ...overrides });
  }

  async function started(result: Result<WorkerRun, unknown>): Promise<WorkerRun> {
    if (!result.ok) throw new Error(`worker did not start: ${JSON.stringify(result.error)}`);
    return result.value;
  }

  it("streams parsed events from the fake and resolves exit with code 0", async () => {
    const run = await started(await worker().start(fakeSpec({ FAKE_CLAUDE_SCENARIO: "ok" })));

    const events = await collect(run);
    const exit = await run.exit;

    expect(run.pid).toBeGreaterThan(0);
    expect(events.slice(0, 2)).toEqual([
      { type: "init", sessionId: SESSION, model: "glm-5.3" },
      { type: "assistant_text", text: "done" },
    ]);
    expect(events[2]).toMatchObject({ type: "other", raw: expect.stringContaining('"type":"result"') });
    expect(events).toHaveLength(3);
    expect(exit).toEqual({ code: 0, signal: null, stderrTail: "", forced: null, sessionMissing: false });
  });
  it("writes the prompt to the child's stdin (fake echoes it into an assistant event)", async () => {
    const prompt = 'Rename `foo` → `bar`.\n\n- keep "quotes" and $VARS literal\n- ünïcødé ✓\n';

    const run = await started(
      await worker().start(fakeSpec({ FAKE_CLAUDE_SCENARIO: "echo-prompt" }, { prompt })),
    );
    const events = await collect(run);

    expect(events).toContainEqual({ type: "assistant_text", text: prompt });
  });
  it("tees raw stdout to logPath", async () => {
    // Also: the log and its directory are created (0600), and a later attempt appends.
    const fixture = await readFile(FIXTURE_429, "utf8");
    const replay = fakeSpec({ FAKE_CLAUDE_FIXTURE: FIXTURE_429 });

    for (let i = 0; i < 2; i += 1) await (await started(await worker().start(replay))).exit;

    expect(await readFile(replay.logPath, "utf8")).toBe(fixture + fixture);
    expect((await stat(replay.logPath)).mode & 0o777).toBe(0o600);
  });
  it("kills the whole process group on timeout and reports forced timeout", async () => {
    const pidFile = join(dir, "pids");
    const sleeper = fakeSpec(
      { FAKE_CLAUDE_SCENARIO: "sleep", FAKE_CLAUDE_PIDFILE: pidFile },
      { timeoutMs: 3000 },
    );

    const run = await started(await worker().start(sleeper));
    const pids = await groupPids(pidFile);
    const events = await collect(run);
    const exit = await run.exit;

    expect(exit).toEqual({
      code: null,
      signal: "SIGTERM",
      stderrTail: "",
      forced: "timeout",
      sessionMissing: false,
    });
    expect(events[0]).toMatchObject({ type: "init" });
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
  });
  it("a resume of a session Claude Code does not have exits with sessionMissing", async () => {
    const resume = fakeSpec(
      { FAKE_CLAUDE_SCENARIO: "no-session" },
      { session: { kind: "resume", key: SESSION } },
    );

    const run = await started(await worker().start(resume));
    await collect(run);

    expect(await run.exit).toEqual({
      code: 1,
      signal: null,
      stderrTail: `No conversation found with session ID: ${SESSION}\n`,
      forced: null,
      sessionMissing: true,
    });
  });
  it("interrupt stops the run: the whole group is gone and the exit reports forced stopped", async () => {
    const pidFile = join(dir, "pids");
    const sleeper = fakeSpec({ FAKE_CLAUDE_SCENARIO: "sleep", FAKE_CLAUDE_PIDFILE: pidFile });

    const run = await started(await worker().start(sleeper));
    const pids = await groupPids(pidFile);
    await run.interrupt("stopped");
    await collect(run);

    expect(await run.exit).toEqual({
      code: null,
      signal: "SIGTERM",
      stderrTail: "",
      forced: "stopped",
      sessionMissing: false,
    });
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
  });
  it("returns no_key / insecure_key_file from loadKey without spawning", async () => {
    const noKey = { kind: "no_key", message: "no key" } as const;
    const insecure = {
      kind: "insecure_key_file",
      label: "key file",
      path: "/home/dev/.config/zai-plugin-cc/env",
      mode: "0644",
    } as const;
    const target = fakeSpec({ FAKE_CLAUDE_SCENARIO: "ok" });

    const results = [];
    for (const error of [noKey, insecure])
      results.push(await worker({ loadKey: async () => err(error) }).start(target));

    expect(results).toEqual([
      { ok: false, error: noKey },
      { ok: false, error: insecure },
    ]);
    // The log is opened right before the spawn, so its absence proves nothing was started.
    await expect(stat(target.logPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("returns spawn_failed when the binary does not exist", async () => {
    const missing = join(dir, "no-such-claude");

    const result = await worker({ bin: missing }).start(fakeSpec({}));

    expect(result).toEqual({
      ok: false,
      error: { kind: "spawn_failed", message: `spawn ${missing} ENOENT` },
    });
  });
  it("returns spawn_failed without spawning when the log cannot be opened", async () => {
    const notADirectory = join(dir, "file");
    await writeFile(notADirectory, "");
    const target = fakeSpec(
      { FAKE_CLAUDE_SCENARIO: "ok" },
      { logPath: join(notADirectory, "attempt-1.jsonl") },
    );

    const result = await worker().start(target);

    expect(result).toEqual({
      ok: false,
      // mkdir over a file: EEXIST on macOS, ENOTDIR on Linux.
      error: {
        kind: "spawn_failed",
        message: expect.stringContaining(`cannot open log ${target.logPath}: Error: E`),
      },
    });
  });

  it("the key never appears in argv, in logPath or in the fake's dumped argv (fake writes its argv/env names to a file)", async () => {
    // The real environment of this test run (which may itself be inside Claude Code) plus planted leaks.
    const parentEnv: Readonly<Record<string, string | undefined>> = {
      ...process.env,
      ...PARENT_ENV,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };
    const dumpPath = join(dir, "dump.json");
    const passEnv = { FAKE_CLAUDE_SCENARIO: "echo-prompt", FAKE_CLAUDE_DUMP: dumpPath };
    const target = fakeSpec(passEnv);

    const run = await started(await worker({ parentEnv }).start(target));
    await collect(run);
    await run.exit;
    const dumpText = await readFile(dumpPath, "utf8");
    const dump: { argv: string[]; envNames: string[]; authTokenSha256: string } = JSON.parse(dumpText);

    expect(dump.argv).toEqual(buildClaudeArgs(target));
    expect(dumpText).not.toContain(KEY);
    expect(await readFile(target.logPath, "utf8")).not.toContain(KEY);
    expect(dump.authTokenSha256).toBe(createHash("sha256").update(KEY).digest("hex"));
    const inherited = ENV_ALLOWLIST.filter((name) => parentEnv[name] !== undefined);
    // This test may itself run inside Claude Code, so the parent's CLAUDE_* settings vary; whatever passes the
    // denylist is exactly what the worker must receive.
    const claudeSettings = Object.keys(pickClaudeSettings(parentEnv));
    const managed = [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "API_TIMEOUT_MS",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "CLAUDE_CONFIG_DIR",
    ];
    // macOS adds __CF_USER_TEXT_ENCODING to every process it starts; it does not come from the parent.
    const received = dump.envNames.filter((name) => name !== "__CF_USER_TEXT_ENCODING");
    expect(received).toEqual([...inherited, ...claudeSettings, ...Object.keys(passEnv), ...managed].sort());
  });
  it("terminates processes the worker left running in its group once it exits", {
    timeout: 10_000,
  }, async () => {
    const pidFile = join(dir, "pids");
    const leaver = fakeSpec({ FAKE_CLAUDE_SCENARIO: "ok", FAKE_CLAUDE_PIDFILE: pidFile });

    const run = await started(await worker().start(leaver));
    const pids = await groupPids(pidFile);
    await collect(run);
    const exit = await run.exit;

    expect(exit).toEqual({ code: 0, signal: null, stderrTail: "", forced: null, sessionMissing: false });
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
  });

  it("a crashing worker resolves exit with its exit code and stderr", async () => {
    const run = await started(await worker().start(fakeSpec({ FAKE_CLAUDE_SCENARIO: "crash" })));

    await collect(run);

    expect(await run.exit).toEqual({
      code: 3,
      signal: null,
      stderrTail: "fake claude: simulated crash\n",
      forced: null,
      sessionMissing: false,
    });
  });

  it("keeps only the last 4000 characters of stderr", async () => {
    const noisy = join(dir, "noisy-claude");
    await writeFile(noisy, "#!/bin/sh\nhead -c 10000 /dev/zero | tr '\\0' x >&2\nprintf END >&2\nexit 1\n", {
      mode: 0o755,
    });

    const run = await started(await worker({ bin: noisy }).start(fakeSpec({})));
    const exit = await run.exit;

    expect(exit.stderrTail).toHaveLength(4000);
    expect(exit.stderrTail.endsWith("xxxEND")).toBe(true);
  });

  it("a timeout beyond setTimeout's range (about 24.8 days) does not fire at once", async () => {
    const run = await started(
      await worker().start(fakeSpec({ FAKE_CLAUDE_SCENARIO: "ok" }, { timeoutMs: 2 ** 32 })),
    );

    await collect(run);

    expect(await run.exit).toMatchObject({ code: 0, forced: null });
  });

  it("skips lines the parser rejects (they stay in the log) and keeps streaming", async () => {
    const fixture = join(dir, "malformed.jsonl");
    const init = '{"type":"system","subtype":"init","session_id":"s-1","model":"glm-5.3"}';
    const said = '{"type":"assistant","message":{"content":[{"type":"text","text":"still here"}]}}';
    await writeFile(fixture, `${init}\n{"type": "assist\n\n${said}\n`);
    const replay = fakeSpec({ FAKE_CLAUDE_FIXTURE: fixture });

    const run = await started(await worker().start(replay));
    const events = await collect(run);
    await run.exit;

    expect(events).toEqual([
      { type: "init", sessionId: "s-1", model: "glm-5.3" },
      { type: "assistant_text", text: "still here" },
    ]);
    expect(await readFile(replay.logPath, "utf8")).toContain('{"type": "assist\n');
  });

  it("delivers every event of a line that parses to several, in order", async () => {
    const fixture = join(dir, "pair.jsonl");
    await writeFile(
      fixture,
      '{"type":"pair"}\n{"type":"assistant","message":{"content":[{"text":"after"}]}}\n',
    );

    const run = await started(await worker().start(fakeSpec({ FAKE_CLAUDE_FIXTURE: fixture })));
    const events = await collect(run);
    await run.exit;

    expect(events).toEqual([
      { type: "assistant_text", text: "first" },
      { type: "tool_use", name: "Bash", summary: "second" },
      { type: "assistant_text", text: "after" },
    ]);
  });

  it("parses a final line that has no trailing newline", async () => {
    const fixture = join(dir, "unterminated.jsonl");
    await writeFile(fixture, '{"type":"assistant","message":{"content":[{"type":"text","text":"last"}]}}');

    const run = await started(await worker().start(fakeSpec({ FAKE_CLAUDE_FIXTURE: fixture })));
    const events = await collect(run);
    await run.exit;

    expect(events).toEqual([{ type: "assistant_text", text: "last" }]);
  });

  it("runs the worker in spec.cwd (the fake's edit-file scenario writes there)", async () => {
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    const edit = fakeSpec(
      { FAKE_CLAUDE_SCENARIO: "edit-file", FAKE_CLAUDE_EDIT: "src/out.txt:hello from glm" },
      {
        cwd: workspace,
      },
    );

    const run = await started(await worker().start(edit));
    const events = await collect(run);
    await run.exit;

    expect(await readFile(join(workspace, "src", "out.txt"), "utf8")).toBe("hello from glm");
    expect(events).toContainEqual({ type: "assistant_text", text: "edited src/out.txt" });
  });

  it("by default parses with domain parseStreamLine", async () => {
    const defaultParser = new ClaudeHeadlessWorker({
      provider: REFERENCE_PROVIDER,
      bin: FAKE_CLAUDE,
      configDir: join(dir, "claude-home"),
      loadKey: async () => LOADED_KEY,
      parentEnv: { PATH: process.env.PATH },
      stopGraceMs: 5_000,
    });

    const run = await started(await defaultParser.start(fakeSpec({ FAKE_CLAUDE_SCENARIO: "ok" })));
    const events = await collect(run);
    await run.exit;

    expect(events.slice(0, 2)).toEqual([
      { type: "init", sessionId: SESSION, model: "glm-5.3" },
      { type: "assistant_text", text: "done" },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      isError: false,
      text: "done",
      structuredOutput: { summary: "fake run" },
      turns: 1,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 },
    });
  });

  it("delivers every line of a long stream, in order", async () => {
    const fixture = join(dir, "long.jsonl");
    const texts = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const line = (text: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
    await writeFile(fixture, `${texts.map(line).join("\n")}\n`);

    const run = await started(await worker().start(fakeSpec({ FAKE_CLAUDE_FIXTURE: fixture })));
    const events = await collect(run);
    await run.exit;

    expect(events).toEqual(texts.map((text) => ({ type: "assistant_text", text })));
  });
});
