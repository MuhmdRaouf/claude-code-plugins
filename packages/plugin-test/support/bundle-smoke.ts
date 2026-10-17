/**
 * The plugin a provider plugin ships, run as the plugin runs it: the plugin-core binary loads and prints its help,
 * the dist/run launcher starts it, setup runs the binary against a throwaway install and reports ready, and its
 * hooks never fail a session. Each provider plugin calls `bundleSmokeSuite` from test/e2e/bundle.test.ts.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { type CoreParity, coreParity, expectCoreStarted, writeCoreLauncher } from "./core-parity.ts";
import { closeServer, listen } from "./net.ts";
import type { Provider } from "./provider.ts";
import { FAKE_CLAUDE } from "./runtime.ts";
import { tempDir } from "./tmp.ts";

export interface BundleSmokeOptions {
  readonly provider: Provider;
  /** The plugin's `plugin/` dir: what Claude Code installs. */
  readonly pluginDir: string;
  /** An executable stand-in for `claude` (default: the shared fake-claude.ts). */
  readonly fakeClaude?: string;
}

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** One run of a command. Spawned, not spawnSync: a sync spawn would block this process's event loop and with it the
 *  fake router below, sending the child off to start a real router. */
function run(command: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<Ran> {
  const child = spawn(command, args, { cwd: env.HOME, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

/** A server answering like the running router (its health, at the running code's own version, and its key check),
 *  so setup's start sees one running and starts nothing real. `routerCode` is the file whose hash is the version
 *  (the plugin-core binary), `frontVersion` the front protocol it speaks (3: the Go front, which never hot-reloads
 *  across kinds). */
async function fakeRouter(provider: Provider, routerCode: string, frontVersion: number): Promise<number> {
  const version = createHash("sha256").update(readFileSync(routerCode)).digest("hex").slice(0, 12);
  const health = {
    ok: true,
    name: provider.name,
    provider: provider.display,
    mode: "router",
    version,
    frontVersion,
  };
  const key = { ok: true, source: provider.keyEnv[0] };
  const server: Server = createServer((request, response) => {
    if (request.url === provider.router.healthPath) return void response.end(JSON.stringify(health));
    if (request.url === `${provider.router.healthPath}/key`) return void response.end(JSON.stringify(key));
    response.statusCode = 404;
    response.end();
  });
  const port = await listen(server);
  onTestFinished(() => closeServer(server));
  return port;
}

/** The bundle smoke tests for one provider plugin. */
export function bundleSmokeSuite(options: BundleSmokeOptions): void {
  const { provider, pluginDir } = options;
  const { name, envPrefix } = provider;
  const fakeClaude = options.fakeClaude ?? FAKE_CLAUDE;
  const baseEnv = (home: string): Record<string, string> => ({
    PATH: process.env.PATH ?? "",
    HOME: home,
    [`${envPrefix}_STATE_DIR`]: join(home, "state"),
  });
  /** A throwaway copy of the plugin whose dist/run starts the installed plugin-core binary. */
  const parityRig = (): {
    readonly root: string;
    readonly parity: CoreParity;
    readonly home: string;
    readonly env: Record<string, string>;
  } => {
    const parity = coreParity(`${name}-bundle-`);
    const root = tempDir(`${name}-bundle-parity-`);
    const home = tempDir(`${name}-bundle-`);
    cpSync(pluginDir, root, { recursive: true });
    writeCoreLauncher(root, name, parity);
    return { root, parity, home, env: { ...baseEnv(home), ...parity.env } };
  };

  /** The setup test's throwaway install: a copy of the plugin (the bundles plus the agents setup rewrites beside
   *  them), a fake router already running on a free port, and the pid file it would have left. The copy's dist/run
   *  starts the installed plugin-core binary (the copy's dist carries no binary of its own); the running router the
   *  fake imitates is the Go front: protocol 3, version the installed binary's own hash — what the core's start
   *  copies from the running executable. */
  const throwawayInstall = async (): Promise<{
    readonly home: string;
    readonly port: number;
    readonly keyEnv: string;
    readonly parity: CoreParity;
  }> => {
    const home = tempDir(`${name}-bundle-`);
    cpSync(join(pluginDir, "dist"), join(home, "dist"), { recursive: true });
    cpSync(join(pluginDir, "agents"), join(home, "agents"), { recursive: true });
    const parity = coreParity(`${name}-bundle-`);
    writeCoreLauncher(home, name, parity);
    const port = await fakeRouter(provider, parity.binary, 3);
    mkdirSync(join(home, "state"), { recursive: true });
    const pidFile = {
      pid: process.pid,
      port,
      version: "test",
      frontVersion: 3,
      mode: "router",
      token: "t",
    };
    writeFileSync(join(home, "state", "router.pid"), JSON.stringify(pidFile));
    return { home, port, keyEnv: provider.keyEnv[0] ?? `${envPrefix}_API_KEY`, parity };
  };

  /** The setup test: the throwaway install's launcher starting the installed plugin-core binary; CLAUDE_PLUGIN_ROOT
   *  tells the binary where the agents to rewrite sit. */
  const setupReady = async (install: {
    readonly home: string;
    readonly port: number;
    readonly keyEnv: string;
    readonly parity: CoreParity;
  }): Promise<void> => {
    const { home, port, keyEnv, parity } = install;
    const result = await run("sh", [join(home, "dist", "run"), `${name}.js`, "setup", "--json"], {
      ...baseEnv(home),
      ...parity.env,
      CLAUDE_PLUGIN_ROOT: home,
      [`${envPrefix}_CLAUDE_BIN`]: fakeClaude,
      [keyEnv]: `${name}-bundle-fake-key`,
      [`${envPrefix}_ROUTER_PORT`]: String(port),
    });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ready: true,
      // plugin-core runs on no runtime; its setup line names the binary, its version and its path — the installed
      // binary the launcher exec'd.
      runtime: `plugin-core ${parity.version} (${parity.binary})`,
      claude: { ok: true, bin: fakeClaude },
      key: { ok: true, value: keyEnv },
      state: expect.stringMatching(new RegExp(`${name}-bundle-.*/state$`)),
      router: { ok: true, value: expect.stringContaining("already running") },
      models: { ok: true, value: `${provider.catalog.main.id}, ${provider.catalog.flash.id}` },
      settings: { ok: true, changed: true },
    });
    expectCoreStarted(parity);
  };

  describe(`the ${name} plugin and the plugin-core binary`, () => {
    it("loads and prints help", async () => {
      const parity = coreParity(`${name}-bundle-`);
      const help = await run(parity.binary, [name, "cli", "--help"], {
        ...baseEnv(tempDir(`${name}-bundle-`)),
        ...parity.env,
      });

      expect(help.stderr).toBe("");
      expect(help.code).toBe(0);
      expect(help.stdout).toContain(`there is no ${name} command on PATH`);
      expect(help.stdout).toContain("\n  run <brief.md|->");
      expectCoreStarted(parity);
    });

    it("the launcher dist/run starts the installed plugin-core binary with every argument", async () => {
      const { root, parity, env } = parityRig();
      const help = await run("sh", [join(root, "dist/run"), `${name}.js`, "--help"], env);

      expect(help.code).toBe(0);
      expect(help.stdout).toContain(`there is no ${name} command on PATH`);
      expect(help.stdout).toContain("\n  run <brief.md|->");
      expectCoreStarted(parity);
    });

    it("setup runs the binary against a throwaway install and reports ready", async () => {
      const install = await throwawayInstall();
      await setupReady(install);
      // The copy's agents were rewritten; the shipped ones still say sonnet.
      const agent = `agents/${provider.agents.main}.md`;
      expect(readFileSync(join(install.home, agent), "utf8")).toContain(`model: ${provider.catalog.main.id}`);
      expect(readFileSync(join(pluginDir, agent), "utf8")).toMatch(/^model: sonnet$/m);
    });

    it("a hook never fails the session: setup --hook exits 0 silently even when its state dir cannot be made", async () => {
      const { root, parity, home, env } = parityRig();
      const broken = join(home, "not-a-dir");
      writeFileSync(broken, "a file where the state dir would go");
      const hookEnv = { ...env, [`${envPrefix}_STATE_DIR`]: join(broken, "state") };

      expect(await run("sh", [join(root, "dist/run"), `${name}.js`, "setup", "--hook"], hookEnv)).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
      expectCoreStarted(parity);
    });

    it("board --hook is silent with nothing to report and exits 0", async () => {
      const { root, env } = parityRig();

      expect(await run("sh", [join(root, "dist/run"), `${name}.js`, "board", "--hook"], env)).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
    });
  });
}
