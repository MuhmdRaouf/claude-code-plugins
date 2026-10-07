/**
 * The built bundle a provider plugin ships, run as the plugin runs it (plugin/dist, not src/): it loads and prints its
 * help, the dist/run launcher starts it, setup runs the bundled core against a throwaway install and reports ready, and
 * its hooks never fail a session. Each provider plugin calls `bundleSmokeSuite` from test/e2e/bundle.test.ts; it runs
 * on node in `npm test` and on bun in `npm run test:bun` (TEST_RUNTIME).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Provider } from "../../src/domain/provider.ts";
import { closeServer, listen } from "./net.ts";
import { FAKE_CLAUDE, testRuntime } from "./runtime.ts";
import { tempDir } from "./tmp.ts";

export interface BundleSmokeOptions {
  readonly provider: Provider;
  /** The plugin's `plugin/` dir: what Claude Code installs. */
  readonly pluginDir: string;
  /** An executable stand-in for `claude` (default: core's fake-claude.ts). */
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

/** A server answering like the running router (its health, at the bundle's own version, and its key check), so
 *  setup's start sees one running and starts nothing real. */
async function fakeRouter(provider: Provider, pluginDir: string): Promise<number> {
  const version = createHash("sha256")
    .update(readFileSync(join(pluginDir, "dist", `${provider.name}-router.js`)))
    .digest("hex")
    .slice(0, 12);
  const health = {
    ok: true,
    name: provider.name,
    provider: provider.display,
    mode: "router",
    version,
    frontVersion: 1,
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

/** The bundle smoke tests for one provider plugin, on the runtime the tests run on. */
export function bundleSmokeSuite(options: BundleSmokeOptions): void {
  const { provider, pluginDir } = options;
  const { name, envPrefix } = provider;
  const fakeClaude = options.fakeClaude ?? FAKE_CLAUDE;
  const runtime = testRuntime();
  const bundle = (dir: string) => join(dir, "dist", `${name}.js`);
  const baseEnv = (home: string): Record<string, string> => ({
    PATH: process.env.PATH ?? "",
    HOME: home,
    [`${envPrefix}_STATE_DIR`]: join(home, "state"),
  });

  describe(`the built ${name} bundle (${basename(runtime)})`, () => {
    it("loads and prints help", async () => {
      const help = await run(runtime, [bundle(pluginDir), "--help"], baseEnv(tempDir(`${name}-bundle-`)));

      expect(help.stderr).toBe("");
      expect(help.code).toBe(0);
      expect(help.stdout).toContain(`there is no ${name} command on PATH`);
      expect(help.stdout).toContain("\n  run <brief.md|->");
    });

    it("the launcher dist/run starts it (bun when on PATH, else node) with every argument", async () => {
      const home = tempDir(`${name}-bundle-`);
      const help = await run("sh", [join(pluginDir, "dist/run"), `${name}.js`, "--help"], baseEnv(home));

      expect(help.code).toBe(0);
      expect(help.stdout).toContain(`there is no ${name} command on PATH`);
      expect(help.stdout).toContain("\n  run <brief.md|->");
    });

    it("setup runs the bundled core against a throwaway install and reports ready", async () => {
      // A copy of the built plugin: the bundle plus the agents setup rewrites beside it.
      const home = tempDir(`${name}-bundle-`);
      cpSync(join(pluginDir, "dist"), join(home, "dist"), { recursive: true });
      cpSync(join(pluginDir, "agents"), join(home, "agents"), { recursive: true });
      const port = await fakeRouter(provider, pluginDir);
      // The pid file a started router leaves, so setup asks it for its key check.
      mkdirSync(join(home, "state"), { recursive: true });
      const pidFile = {
        pid: process.pid,
        port,
        version: "test",
        frontVersion: 1,
        mode: "router",
        token: "t",
      };
      writeFileSync(join(home, "state", "router.pid"), JSON.stringify(pidFile));
      const keyEnv = provider.keyEnv[0] ?? `${envPrefix}_API_KEY`;

      const result = await run(runtime, [bundle(home), "setup", "--json"], {
        ...baseEnv(home),
        [`${envPrefix}_CLAUDE_BIN`]: fakeClaude,
        [keyEnv]: `${name}-bundle-fake-key`,
        [`${envPrefix}_ROUTER_PORT`]: String(port),
      });

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ready: true,
        runtime: expect.stringMatching(new RegExp(`^${basename(runtime)} \\d`)),
        claude: { ok: true, bin: fakeClaude },
        key: { ok: true, value: keyEnv },
        state: expect.stringMatching(new RegExp(`${name}-bundle-.*/state$`)),
        router: { ok: true, value: expect.stringContaining("already running") },
        models: { ok: true, value: `${provider.catalog.main.id}, ${provider.catalog.flash.id}` },
        settings: { ok: true, changed: true },
      });
      // The copy's agents were rewritten; the shipped ones still say sonnet.
      const agent = `agents/${provider.agents.main}.md`;
      expect(readFileSync(join(home, agent), "utf8")).toContain(`model: ${provider.catalog.main.id}`);
      expect(readFileSync(join(pluginDir, agent), "utf8")).toMatch(/^model: sonnet$/m);
    });

    it("a hook never fails the session: setup --hook exits 0 silently even when its state dir cannot be made", async () => {
      const home = tempDir(`${name}-bundle-`);
      writeFileSync(join(home, "not-a-dir"), "a file where the state dir would go");
      const env = { ...baseEnv(home), [`${envPrefix}_STATE_DIR`]: join(home, "not-a-dir", "state") };

      expect(await run(runtime, [bundle(pluginDir), "setup", "--hook"], env)).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
    });

    it("board --hook is silent with nothing to report and exits 0", async () => {
      const env = baseEnv(tempDir(`${name}-bundle-`));

      expect(await run(runtime, [bundle(pluginDir), "board", "--hook"], env)).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
    });
  });
}
