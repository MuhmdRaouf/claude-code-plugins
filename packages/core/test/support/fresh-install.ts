/**
 * A brand-new user, scripted: the plugin copied the way `claude plugin install` lays it out (the marketplace entry's
 * `plugin/` dir under `~/.claude/plugins/cache/<marketplace>/<entry>/<version>`, with CLAUDE_PLUGIN_ROOT and
 * CLAUDE_PLUGIN_DATA set as Claude Code sets them), a temp HOME holding nothing but a `package.json` of its own, PATH
 * limited to the system dirs and one runtime, and the exact command lines the plugin's hooks.json and commands/*.md
 * run. The only things the user does are what setup asks: run setup and enter a key on its one-time page. No env var
 * the user would have to set is used; the test-only ones point the provider, the Anthropic upstream and the router
 * port at local fakes. Each provider plugin calls `freshInstallSuite` with its own provider and dirs.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { basename, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Provider } from "../../src/domain/provider.ts";
import { closeServer, freePort, listen } from "./net.ts";
import { FAKE_CLAUDE, testRuntime } from "./runtime.ts";
import { tempDir } from "./tmp.ts";

export interface FreshInstallOptions {
  readonly provider: Provider;
  /** The plugin's `plugin/` dir: what the marketplace entry's `source` names. */
  readonly pluginDir: string;
  /** An executable stand-in for `claude` (default: core's test/support/fake-claude.ts). */
  readonly fakeClaude?: string;
}

const MARKETPLACE = "muhmdraouf";
const TEST_TIMEOUT_MS = 180_000;

interface Seen {
  readonly url: string;
  readonly model: string;
  readonly authSha: string;
}

/** A local stand-in for both the provider's Anthropic-compatible API and Anthropic's: 200 for every message. */
async function fakeUpstream(): Promise<{
  readonly url: string;
  readonly seen: Seen[];
  readonly server: Server;
}> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      let model = "";
      try {
        model = String((JSON.parse(body) as { model?: unknown }).model ?? "");
      } catch {
        model = "";
      }
      const auth = String(req.headers.authorization ?? req.headers["x-api-key"] ?? "");
      seen.push({ url: req.url ?? "", model, authSha: sha(auth) });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "pong" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  const port = await listen(server);
  onTestFinished(() => closeServer(server));
  return { url: `http://127.0.0.1:${port}`, seen, server };
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The commands the plugin runs: hooks.json's per event, and each command file's `!` lines and bash blocks. */
export function pluginCommands(pluginDir: string): {
  readonly hooks: Readonly<Record<string, readonly string[]>>;
  readonly commands: Readonly<Record<string, readonly string[]>>;
} {
  const hooksFile = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  const hooks = Object.fromEntries(
    Object.entries(hooksFile.hooks).map(([event, groups]) => [
      event,
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
    ]),
  );
  const commands: Record<string, string[]> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}:`);
      else if (entry.name.endsWith(".md")) {
        const text = readFileSync(join(dir, entry.name), "utf8");
        const inline = [...text.matchAll(/^!`([^`]+)`$/gm)].map((m) => m[1] as string);
        const blocks = [...text.matchAll(/```bash\n([^`]+?)\n```/g)].map((m) => (m[1] as string).trim());
        commands[`${prefix}${basename(entry.name, ".md")}`] = [...inline, ...blocks];
      }
    }
  };
  walk(join(pluginDir, "commands"), "");
  return { hooks, commands };
}

interface Sandbox {
  readonly home: string;
  readonly root: string;
  readonly data: string;
  readonly settings: string;
  readonly opened: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Lays the plugin out as an install does and builds the env Claude Code gives its hooks and Bash tool calls. */
function sandbox(
  options: FreshInstallOptions,
  runtime: string,
  upstream: string,
  routerPort: number,
): Sandbox {
  const { provider } = options;
  const home = tempDir(`${provider.name}-fresh-`);
  const entry = `${provider.name}-plugin-cc`;
  const root = join(home, ".claude", "plugins", "cache", MARKETPLACE, entry, "0.0.1");
  cpSync(options.pluginDir, root, { recursive: true });
  const data = join(home, ".claude", "plugins", "data", `${entry}-${MARKETPLACE}`);
  mkdirSync(data, { recursive: true });
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(
    settings,
    `${JSON.stringify({ enabledPlugins: { [`${entry}@${MARKETPLACE}`]: true } }, null, 2)}\n`,
  );
  // The user's own package.json above the install: Node must still load the plugin's bundles as ESM.
  writeFileSync(join(home, "package.json"), `${JSON.stringify({ name: "me", type: "commonjs" })}\n`);
  mkdirSync(join(home, "proj"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  symlinkSync(runtime, join(bin, basename(runtime)));
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script("claude", `exec "${runtime}" "${options.fakeClaude ?? FAKE_CLAUDE}" "$@"`);
  // The browser opener records the URL instead of opening a browser.
  const opened = join(home, "opened.log");
  for (const opener of ["open", "xdg-open"]) script(opener, `echo "$@" >> "${opened}"`);
  const prefix = provider.envPrefix;
  const env: Record<string, string> = {
    HOME: home,
    USER: process.env.USER ?? "user",
    TMPDIR: join(home, "tmp"),
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    CLAUDE_PLUGIN_ROOT: root,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PROJECT_DIR: join(home, "proj"),
    // Test-only: local fakes for the provider, for Anthropic, and a free port for the router.
    [`${prefix}_BASE_URL`]: upstream,
    [`${prefix}_ROUTER_ANTHROPIC_URL`]: upstream,
    [`${prefix}_ROUTER_PORT`]: String(routerPort),
  };
  mkdirSync(env.TMPDIR as string);
  return { home, root, data, settings, opened, env };
}

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one command line as Claude Code does (`sh -c`, in the project dir), with `stdin` piped in. */
function sh(box: Sandbox, command: string, stdin = "", onStdout?: (text: string) => void): Promise<Ran> {
  const child: ChildProcess = spawn("/bin/sh", ["-c", command], {
    cwd: join(box.home, "proj"),
    env: box.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    onStdout?.(stdout);
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdin?.end(stdin);
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

/** Fills the one-time key page as a user would in the browser: load it, post the form with its CSRF value. */
async function enterKey(url: string, key: string): Promise<string> {
  const page = await (await fetch(url)).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
  const response = await fetch(url, {
    method: "POST",
    headers: { origin: new URL(url).origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, key }).toString(),
  });
  return response.text();
}

function hookInput(event: string, cwd: string): string {
  return JSON.stringify({ session_id: "fresh", transcript_path: "/dev/null", cwd, hook_event_name: event });
}

function routerPid(box: Sandbox): number | undefined {
  try {
    return (JSON.parse(readFileSync(join(box.data, "router.pid"), "utf8")) as { pid?: number }).pid;
  } catch {
    return undefined;
  }
}

const FAKE_KEY = "fresh-install-fake-key-0123456789";

/** One scripted user's state across the steps below. */
interface Run {
  readonly box: Sandbox;
  readonly provider: Provider;
  readonly upstream: { readonly seen: Seen[] };
  readonly routerUrl: string;
  readonly hooks: Readonly<Record<string, readonly string[]>>;
  readonly commands: Readonly<Record<string, readonly string[]>>;
}

function killRouter(box: Sandbox): void {
  const pid = routerPid(box);
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function runHooks(run: Run, event: string): Promise<void> {
  for (const line of run.hooks[event] ?? []) {
    const ran = await sh(run.box, line, hookInput(event, join(run.box.home, "proj")));
    expect({ event, line, ...ran }).toMatchObject({ code: 0, stderr: "" });
    expect(ran.stdout.trim().split("\n").filter(Boolean).length).toBeLessThanOrEqual(1);
  }
}

/** The built-in setup's line: `setup:claude` runs it alone, and `setup` runs the very same line after its questions. */
function builtInSetup(run: Run): string {
  const line = run.commands["setup:claude"]?.[0] ?? "false";
  expect(run.commands["setup:claude"]).toEqual([line]);
  expect(line).toMatch(/ setup$/);
  expect(run.commands.setup).toContain(line);
  return line;
}

/** What `setup` reads before it asks anything (its first line, `setup --engines --json`): read-only, never a crash. */
async function setupMenuState(run: Run, setupDone: boolean): Promise<void> {
  const line = run.commands.setup?.[0] ?? "false";
  expect(line).toMatch(/ setup --engines --json$/);
  const ran = await sh(run.box, line);
  expect({ line, code: ran.code, stderr: ran.stderr }).toEqual({ line, code: 0, stderr: "" });
  const state = JSON.parse(ran.stdout) as { setup: boolean; engines: { engine: string; watcher: null }[] };
  expect(state.setup).toBe(setupDone);
  expect(state.engines.map(({ engine, watcher }) => [engine, watcher])).toEqual([
    ["omp", null],
    ["opencode", null],
    ["pi", null],
  ]);
}

/** Session start before setup: every hook exits 0, says at most one line and leaves settings.json alone; board, usage
 *  and the setup menu's state read answer too. */
async function beforeSetup(run: Run, before: Buffer): Promise<void> {
  for (const event of Object.keys(run.hooks)) await runHooks(run, event);
  expect(readFileSync(run.box.settings).equals(before)).toBe(true);
  for (const name of ["board", "usage"]) {
    const ran = await sh(run.box, run.commands[name]?.[0] ?? "false");
    expect({ name, ...ran }).toMatchObject({ code: 0, stderr: "" });
  }
  await setupMenuState(run, false);
  expect(readFileSync(run.box.settings).equals(before)).toBe(true);
}

/** setup with no key opens the one-time page (in the browser: the opener shim records it); the user enters a key
 *  there; setup checks it, starts the router, edits settings.json and the agents, and says ready. */
async function setupWithKeyPage(run: Run): Promise<void> {
  const { box, provider } = run;
  let entered: Promise<string> | undefined;
  const setup = await sh(box, builtInSetup(run), "", (text) => {
    const url = /http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+/.exec(text)?.[0];
    if (url !== undefined && entered === undefined) entered = enterKey(url, FAKE_KEY);
  });
  expect(await entered).toContain("Saved");
  expect(readFileSync(box.opened, "utf8")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  expect(setup).toMatchObject({ code: 0, stderr: "" });
  expect(setup.stdout).toContain("ready");
  expect(run.upstream.seen.some((seen) => seen.authSha === sha(`Bearer ${FAKE_KEY}`))).toBe(true);
  const settings = JSON.parse(readFileSync(box.settings, "utf8")) as {
    modelPicker: { options: { model: string }[] };
    env: { ANTHROPIC_BASE_URL: string };
  };
  expect(settings.env.ANTHROPIC_BASE_URL).toBe(run.routerUrl);
  expect(settings.modelPicker.options.map((option) => option.model)).toEqual([
    provider.catalog.main.id,
    provider.catalog.flash.id,
  ]);
  expect(readFileSync(join(box.root, "agents", `${provider.agents.main}.md`), "utf8")).toContain(
    `model: ${provider.catalog.main.id}`,
  );
}

/** The router sends the provider's model with the stored key and a claude-* model to Anthropic untouched; killed, it
 *  comes back on the next prompt's hook. */
async function routesAndRecovers(run: Run): Promise<void> {
  const { provider, routerUrl } = run;
  for (const model of [provider.catalog.main.id, "claude-sonnet-5-5"]) {
    const response = await fetch(`${routerUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "sk-ant-fake",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    expect({ model, status: response.status }).toEqual({ model, status: 200 });
    await response.text();
  }
  const routed = run.upstream.seen.filter((seen) => seen.url.startsWith("/v1/messages"));
  expect(routed.find((seen) => seen.model === provider.catalog.main.id)?.authSha).toBe(
    sha(`Bearer ${FAKE_KEY}`),
  );
  expect(routed.find((seen) => seen.model === "claude-sonnet-5-5")?.authSha).toBe(sha("sk-ant-fake"));
  const pid = routerPid(run.box);
  expect(pid).toBeDefined();
  process.kill(pid as number, "SIGKILL");
  await runHooks(run, "UserPromptSubmit");
  const health = async () =>
    (await fetch(`${routerUrl}${provider.router.healthPath}`).catch(() => undefined))?.status;
  await expect.poll(health, { timeout: 20_000 }).toBe(200);
}

/** Session start after setup changes nothing already right; the absent optional engines are reported (exit 6), never
 *  a crash, and change nothing. */
async function afterSetup(run: Run): Promise<void> {
  const configured = readFileSync(run.box.settings);
  await runHooks(run, "SessionStart");
  expect(readFileSync(run.box.settings).equals(configured)).toBe(true);
  await setupMenuState(run, true);
  for (const engine of ["omp", "opencode", "pi"]) {
    const ran = await sh(run.box, run.commands[`setup:${engine}`]?.[0] ?? "false");
    expect(ran.code).toBe(6);
    expect(ran.stderr).not.toMatch(/at .+:\d+:\d+|TypeError|SyntaxError/);
    const report = JSON.parse(ran.stdout) as { engine: { binary: { ok: boolean; error: string } } };
    expect(report.engine.binary).toEqual({ ok: false, error: `${engine} is not on PATH` });
  }
  expect(readFileSync(run.box.settings).equals(configured)).toBe(true);
}

/** The fresh-install suite on the runtime the tests run on (TEST_RUNTIME: node by default, bun in test:bun). */
export function freshInstallSuite(options: FreshInstallOptions): void {
  const { provider } = options;
  const runtime = testRuntime();
  const slash = provider.slash;

  describe(`a fresh install of ${provider.name} (${basename(runtime)})`, () => {
    it("ships what an install needs: an executable launcher and the bundles marked as ESM", () => {
      const run = statSync(join(options.pluginDir, "dist", "run"));
      expect(run.mode & 0o111).not.toBe(0);
      expect(JSON.parse(readFileSync(join(options.pluginDir, "dist", "package.json"), "utf8"))).toMatchObject(
        {
          type: "module",
        },
      );
      for (const command of Object.values(pluginCommands(options.pluginDir).hooks).flat())
        expect(command).toMatch(/^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/run" [a-z-]+\.js /);
    });

    it(
      `works with ${slash}setup as the only step, and setup --remove puts settings.json back byte for byte`,
      async () => {
        const upstream = await fakeUpstream();
        const routerPort = await freePort();
        const box = sandbox(options, runtime, upstream.url, routerPort);
        onTestFinished(() => killRouter(box));
        const run: Run = {
          box,
          provider,
          upstream,
          routerUrl: `http://127.0.0.1:${routerPort}`,
          ...pluginCommands(box.root),
        };
        const before = readFileSync(box.settings);

        await beforeSetup(run, before);
        await setupWithKeyPage(run);
        await routesAndRecovers(run);
        await afterSetup(run);
        // setup --remove: settings.json is what it was before setup, byte for byte; the router is gone.
        const removed = await sh(box, builtInSetup(run).replace(/ setup$/, " setup --remove"));
        expect(removed).toMatchObject({ code: 0, stderr: "" });
        expect(readFileSync(box.settings, "utf8")).toBe(before.toString("utf8"));
        expect(existsSync(join(box.data, "router.pid"))).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );
  });
}
