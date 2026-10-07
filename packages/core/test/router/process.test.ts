import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSettingsPath } from "../../src/adapters/claude-settings.ts";
import { portAnswers } from "../../src/adapters/process/port.ts";
import { FRONT_VERSION, NO_WORKER, TOKEN_HEADER } from "../../src/router/front.ts";
import { readPidFile, writePidFile } from "../../src/router/pidfile.ts";
import {
  bundleVersion,
  childEnv,
  commandLineOf,
  copyRouterFiles,
  freePort,
  guardBaseUrl,
  isOurProcess,
  ourHealth,
  probeRouter,
  ROUTER_PACKAGE_JSON,
  routerKeyCheck,
  routerStatus,
  type SpawnDetached,
  type StartOptions,
  startRouter,
  stopRouter,
} from "../../src/router/process.ts";
import { saveRegistryEntry } from "../../src/router/registry.ts";
import { ACME_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";

const HEALTH = ACME_PROVIDER.router.healthPath;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A server that holds a port the way something on this machine would. */
async function hold(port: number, handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return server;
}

interface FakeRouter {
  readonly pid: number;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly controls: { action: string; body: string }[];
  server?: http.Server;
  killed: boolean;
}

let nextPid = 900_000;

/** A spawner that runs no process: each "router" is an in-process server answering health like a real one. */
function fakeSpawner(behaviour: {
  router?: "ok" | "dies" | "silent";
  emergency?: "ok" | "dies";
  version?: string;
}): { spawn: SpawnDetached; started: FakeRouter[] } {
  const started: FakeRouter[] = [];
  const spawnFake: SpawnDetached = (_node, args, env) => {
    const emergency = String(args[0]).endsWith("-passthrough.js");
    const fake: FakeRouter = { pid: nextPid++, args, env, controls: [], killed: false };
    started.push(fake);
    const how = emergency ? (behaviour.emergency ?? "ok") : (behaviour.router ?? "ok");
    const port = Number(env.ACME_ROUTER_LISTEN_PORT ?? env.ACME_ROUTER_PORT);
    if (how === "ok") void listenAs(fake, port, emergency ? "emergency" : "router", behaviour.version);
    return {
      pid: fake.pid,
      exited: () => how === "dies" || fake.killed,
      kill: () => {
        fake.killed = true;
        fake.server?.closeAllConnections();
        fake.server?.close();
      },
    };
  };
  return { spawn: spawnFake, started };
}

async function listenAs(fake: FakeRouter, port: number, mode: string, version = "v-new"): Promise<void> {
  const health = JSON.stringify({
    ok: true,
    name: "acme",
    provider: "Acme Models",
    mode,
    version,
    frontVersion: FRONT_VERSION,
    pid: fake.pid,
  });
  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === HEALTH) return void res.end(health);
      const action = req.url?.slice(HEALTH.length + 1) ?? "";
      fake.controls.push({ action, body: Buffer.concat(chunks).toString() });
      if (req.headers[TOKEN_HEADER] !== fake.env.ACME_ROUTER_TOKEN) return void res.writeHead(403).end("{}");
      void controlled(action, res);
    });
  };
  const controlled = async (action: string, res: http.ServerResponse): Promise<void> => {
    if (action === "adopt") {
      res.end(JSON.stringify({ ok: await adopt(Number(fake.env.ACME_ROUTER_PORT), handler) }));
      return;
    }
    res.end('{"ok":true}');
    if (action === "handover") {
      server.closeAllConnections();
      server.close();
    }
  };
  const server = http.createServer(handler);
  fake.server = server;
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
}

/** The new front's half of a handover: bind the canonical port, retrying while the old one still holds it. */
async function adopt(port: number, handler: http.RequestListener): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const taker = http.createServer(handler);
    const bound = await new Promise<boolean>((resolve) => {
      taker.once("error", () => resolve(false));
      taker.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (bound) {
      cleanups.push(() => {
        taker.closeAllConnections();
        taker.close();
      });
      return true;
    }
    await sleep(10);
  }
  return false;
}

interface Setup {
  readonly root: string;
  readonly dist: string;
  readonly state: string;
  readonly port: number;
  readonly env: Record<string, string>;
  readonly home: string;
  readonly settings: string;
  options(extra?: Partial<StartOptions>): StartOptions;
}

async function setup(): Promise<Setup> {
  const root = tempDir("router-start-");
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "acme-router.js"), "// router v1\n");
  writeFileSync(join(dist, "acme-passthrough.js"), "// passthrough\n");
  const port = await freePort();
  const env = {
    HOME: join(root, "home"),
    PROVIDER_ROUTERS_HOME: join(root, "routers"),
    ACME_ROUTER_PORT: String(port),
  };
  const state = join(root, "state");
  return {
    root,
    dist,
    state,
    port,
    env,
    home: env.HOME,
    settings: claudeSettingsPath(env),
    options: (extra = {}) => ({
      provider: ACME_PROVIDER,
      env,
      stateRoot: state,
      distDir: dist,
      node: "/node",
      budgetMs: 6000,
      healthWaitMs: 1500,
      answers: async () => false,
      ...extra,
    }),
  };
}

function pointSettingsAt(s: Setup, url: string): void {
  mkdirSync(join(s.home, ".claude"), { recursive: true });
  writeFileSync(
    s.settings,
    `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: url, OTHER: "kept" } }, null, 2)}\n`,
  );
}

const baseUrlIn = (s: Setup): unknown =>
  (JSON.parse(readFileSync(s.settings, "utf8")) as { env: Record<string, unknown> }).env;

describe("the pieces", () => {
  it("copies the bundles only when they differ, and versions them by content", () => {
    const root = tempDir("router-copy-");
    const dist = join(root, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "acme-router.js"), "one");
    writeFileSync(join(dist, "acme-passthrough.js"), "pass");
    const first = copyRouterFiles(dist, join(root, "state"), "acme");
    expect(first).toMatchObject({ ok: true, value: { version: bundleVersion("one") } });
    const copied = join(root, "state", "router", "acme-router.js");
    const before = statSync(copied).mtimeMs;
    expect(copyRouterFiles(dist, join(root, "state"), "acme").ok).toBe(true);
    expect(statSync(copied).mtimeMs).toBe(before);
    writeFileSync(join(dist, "acme-router.js"), "two");
    expect(copyRouterFiles(dist, join(root, "state"), "acme")).toMatchObject({
      value: { version: bundleVersion("two") },
    });
    expect(copyRouterFiles(join(root, "nope"), join(root, "state2"), "acme")).toMatchObject({
      ok: false,
      error: expect.stringContaining("copying the router"),
    });
    expect(bundleVersion("one")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("marks the copied bundles as ESM, so Node runs them under a CommonJS package.json above the state root", () => {
    const root = tempDir("router-esm-");
    // A user's own package.json above everything: ~/package.json, say, with "type": "commonjs".
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
    const dist = join(root, "dist");
    mkdirSync(dist);
    writeFileSync(
      join(dist, "acme-router.js"),
      'import { argv } from "node:process";\nconsole.log("esm", argv.length > 0);\n',
    );
    writeFileSync(join(dist, "acme-passthrough.js"), "pass");
    const manifest = join(root, "state", "router", "package.json");
    // A state root from before the manifest existed, or one someone edited, is set right on the next copy.
    mkdirSync(join(root, "state", "router"), { recursive: true });
    writeFileSync(manifest, "{}\n");
    const copied = copyRouterFiles(dist, join(root, "state"), "acme");

    expect(copied.ok).toBe(true);
    expect(readFileSync(manifest, "utf8")).toBe(ROUTER_PACKAGE_JSON);
    expect(JSON.parse(ROUTER_PACKAGE_JSON)).toMatchObject({ type: "module" });
    const run = spawnSync(process.execPath, [join(root, "state", "router", "acme-router.js")], {
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("esm true\n");
  });

  it("recognises our health only by its name and provider", () => {
    expect(
      ourHealth('{"ok":true,"name":"acme","provider":"Acme Models"}', "acme", "Acme Models"),
    ).toBeDefined();
    expect(ourHealth('{"ok":true}', "acme", "Acme Models")).toBeUndefined();
    expect(
      ourHealth('{"ok":true,"name":"kimi","provider":"Acme Models"}', "acme", "Acme Models"),
    ).toBeUndefined();
    expect(ourHealth("null", "acme", "Acme Models")).toBeUndefined();
    expect(ourHealth("<html>", "acme", "Acme Models")).toBeUndefined();
  });

  it("probes: nothing, ours, someone else (any 200 is not enough), and a port that never answers", async () => {
    const port = await freePort();
    expect(await probeRouter(port, ACME_PROVIDER)).toEqual({ state: "none" });
    expect(await portAnswers(port, 100)).toBe(false);
    await hold(port, (req, res) =>
      res.end(req.url === HEALTH ? '{"ok":true,"name":"acme","provider":"Acme Models","mode":"router"}' : ""),
    );
    expect(await probeRouter(port, ACME_PROVIDER)).toMatchObject({
      state: "ours",
      health: { mode: "router" },
    });

    const foreign = await freePort();
    await hold(foreign, (_req, res) => res.end("hello"));
    expect(await probeRouter(foreign, ACME_PROVIDER)).toEqual({ state: "foreign" });

    const silent = await freePort();
    await hold(silent, () => undefined);
    expect(await probeRouter(silent, ACME_PROVIDER)).toEqual({ state: "silent" });
  });

  it("passes the router what it needs and nothing else: state, key, proxies in any case (loopback exempt), CA files", () => {
    const env = childEnv(
      ACME_PROVIDER,
      {
        HOME: "/h",
        PATH: "/bin",
        https_proxy: "http://p:1",
        HTTP_PROXY: "http://p:2",
        No_Proxy: "local",
        NODE_EXTRA_CA_CERTS: "/ca.pem",
        SSL_CERT_FILE: "/cert.pem",
        NODE_USE_ENV_PROXY: "1",
        ACME_API_KEY: "k",
        ACME_ROUTER_URL: "http://x",
        SECRET_OTHER: "no",
        UNDEFINED: undefined,
      },
      "/state",
      { ACME_ROUTER_TOKEN: "t" },
    );
    expect(env).toEqual({
      HOME: "/h",
      PATH: "/bin",
      https_proxy: "http://p:1",
      HTTP_PROXY: "http://p:2",
      // Loopback (the front, its worker, the peers) never goes through the proxy.
      NO_PROXY: "local,127.0.0.1,localhost",
      no_proxy: "local,127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      SSL_CERT_FILE: "/cert.pem",
      NODE_USE_ENV_PROXY: "1",
      ACME_API_KEY: "k",
      ACME_ROUTER_URL: "http://x",
      ACME_ROUTER_PORT: "18800",
      ACME_STATE_DIR: "/state",
      ACME_ROUTER_TOKEN: "t",
    });
  });

  it("reads a pid's command line, and calls it ours only when it runs one of our bundles", () => {
    expect(commandLineOf(process.pid)).toContain("node");
    expect(isOurProcess(1, "acme", () => "node /s/router/acme-router.js run")).toBe(true);
    expect(isOurProcess(1, "acme", () => "node /s/router/acme-passthrough.js")).toBe(true);
    expect(isOurProcess(1, "acme", () => "node /s/router/kimi-router.js run")).toBe(false);
    expect(isOurProcess(1, "acme", () => undefined)).toBe(false);
  });
});

describe("startRouter", () => {
  it("starts a fresh router, waits for its health and writes the pid file", async () => {
    const s = await setup();
    const fake = fakeSpawner({});
    const result = await startRouter(s.options({ spawn: fake.spawn }));
    expect(result).toEqual({
      ok: true,
      value: `running on http://127.0.0.1:${s.port} (pid ${fake.started[0]?.pid})`,
    });
    expect(fake.started[0]?.args).toEqual([join(s.state, "router", "acme-router.js"), "run"]);
    const record = readPidFile(s.state);
    expect(record).toMatchObject({ pid: fake.started[0]?.pid, port: s.port, mode: "router", node: "/node" });
    expect(record?.token).toBe(fake.started[0]?.env.ACME_ROUTER_TOKEN);
    expect(existsSync(join(s.state, "router.lock"))).toBe(false);
  });

  it("finds it already running at this version and does nothing", async () => {
    const s = await setup();
    const version = bundleVersion("// router v1\n");
    const fake = fakeSpawner({ version });
    await startRouter(s.options({ spawn: fake.spawn }));
    const again = await startRouter(s.options({ spawn: fake.spawn }));
    expect(again).toEqual({ ok: true, value: `running on http://127.0.0.1:${s.port} (already running)` });
    expect(fake.started).toHaveLength(1);
  });

  it("hot-updates an older router over its control endpoint without restarting it", async () => {
    const s = await setup();
    const fake = fakeSpawner({ version: "old" });
    await startRouter(s.options({ spawn: fake.spawn }));
    const updated = await startRouter(s.options({ spawn: fake.spawn }));
    expect(updated).toMatchObject({ ok: true, value: expect.stringContaining("without closing the port") });
    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]?.controls).toEqual([
      {
        action: "reload",
        body: JSON.stringify({
          exec: join(s.state, "router", "acme-router.js"),
          version: bundleVersion("// router v1\n"),
        }),
      },
    ]);
    expect(readPidFile(s.state)?.version).toBe(bundleVersion("// router v1\n"));
  });

  it("cannot update a router without its pid file, or when it refuses", async () => {
    const s = await setup();
    await hold(s.port, (req, res) =>
      res.end(
        req.url === HEALTH
          ? JSON.stringify({
              ok: true,
              name: "acme",
              provider: "Acme Models",
              mode: "router",
              version: "old",
              frontVersion: FRONT_VERSION,
            })
          : "{}",
      ),
    );
    expect(await startRouter(s.options())).toMatchObject({
      ok: true,
      value: expect.stringContaining("no pid file"),
    });
    writePidFile(s.state, {
      pid: 1,
      port: s.port,
      startedAt: "t",
      node: "n",
      version: "old",
      frontVersion: FRONT_VERSION,
      mode: "router",
      token: "x",
    });
    expect(await startRouter(s.options())).toMatchObject({
      ok: true,
      value: expect.stringContaining("refused"),
    });
  });

  it("falls back to the emergency passthrough when the router dies at start, and errs when both do", async () => {
    const s = await setup();
    pointSettingsAt(s, `http://127.0.0.1:${s.port}`);
    const fake = fakeSpawner({ router: "dies" });
    const result = await startRouter(s.options({ spawn: fake.spawn }));
    expect(result).toMatchObject({
      ok: true,
      value: expect.stringContaining("as the emergency passthrough"),
    });
    expect(readPidFile(s.state)?.mode).toBe("emergency");
    expect(baseUrlIn(s)).toEqual({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${s.port}`, OTHER: "kept" });

    const both = await setup();
    pointSettingsAt(both, `http://127.0.0.1:${both.port}`);
    const lines: string[] = [];
    const failed = await startRouter(
      both.options({
        spawn: fakeSpawner({ router: "silent", emergency: "dies" }).spawn,
        say: (line) => lines.push(line),
      }),
    );
    expect(failed).toMatchObject({
      ok: false,
      error: expect.stringContaining("neither did the emergency passthrough"),
    });
    // Nothing of ours holds the port: Claude Code must not keep pointing at it.
    expect(baseUrlIn(both)).toEqual({ OTHER: "kept" });
    expect(lines.join()).toContain("the router could not start");
  });

  it("goes straight to the emergency passthrough when the bundles cannot be copied", async () => {
    const s = await setup();
    const fake = fakeSpawner({});
    const result = await startRouter(s.options({ spawn: fake.spawn, distDir: join(s.root, "missing") }));
    expect(fake.started.map((f) => f.args[0])).toEqual([join(s.root, "missing", "acme-passthrough.js")]);
    expect(result).toMatchObject({ ok: true, value: expect.stringContaining("emergency passthrough") });
  });

  it("hands the port from the emergency passthrough to a fresh router, or keeps it when the new one fails", async () => {
    const s = await setup();
    await startRouter(s.options({ spawn: fakeSpawner({ router: "dies" }).spawn }));
    expect(readPidFile(s.state)?.mode).toBe("emergency");
    const failing = await startRouter(s.options({ spawn: fakeSpawner({ router: "dies" }).spawn }));
    expect(failing).toMatchObject({ ok: true, value: expect.stringContaining("the running one stays") });
    const fake = fakeSpawner({});
    const handed = await startRouter(s.options({ spawn: fake.spawn }));
    expect(handed).toMatchObject({
      ok: true,
      value: expect.stringContaining("replaced the emergency passthrough"),
    });
    expect(readPidFile(s.state)).toMatchObject({ mode: "router", pid: fake.started[0]?.pid });
    expect((await probeRouter(s.port, ACME_PROVIDER)).state).toBe("ours");
  });

  it("leaves a port someone else holds alone, says so, and takes the base URL off it", async () => {
    const s = await setup();
    pointSettingsAt(s, `http://127.0.0.1:${s.port}`);
    await hold(s.port, (_req, res) => res.end("squatter"));
    const result = await startRouter(s.options({ spawn: fakeSpawner({}).spawn }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("held by another program") });
    expect(baseUrlIn(s)).toEqual({ OTHER: "kept" });
  });

  it("replaces our own router when it hangs, and leaves a silent stranger alone", async () => {
    const s = await setup();
    await hold(s.port, () => undefined);
    expect(await startRouter(s.options({ spawn: fakeSpawner({}).spawn }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("does not answer"),
    });

    const hung = await setup();
    const silent = await hold(hung.port, () => undefined);
    const child: ChildProcess = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "acme-router.js"],
      {
        stdio: "ignore",
      },
    );
    cleanups.push(() => child.kill("SIGKILL"));
    await sleep(100);
    mkdirSync(hung.state, { recursive: true });
    writePidFile(hung.state, {
      pid: child.pid as number,
      port: hung.port,
      startedAt: "t",
      node: "n",
      version: "v",
      frontVersion: FRONT_VERSION,
      mode: "router",
      token: "x",
    });
    const fake = fakeSpawner({});
    // The silent server keeps the port for the whole start, so the outcome does not depend on when it lets go.
    const result = await startRouter(hung.options({ spawn: fake.spawn }));
    silent.closeAllConnections();
    silent.close();
    expect(
      child.signalCode ?? (await new Promise((resolve) => child.on("exit", (_c, signal) => resolve(signal)))),
    ).toBe("SIGKILL");
    // Killing our hung router does not free the port: the silent server holding it is not ours, so it is left alone.
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("held by another program") });
  });

  it("starts exactly one router when two starts race, and takes over a stale lock", async () => {
    const s = await setup();
    const fake = fakeSpawner({});
    const [one, two] = await Promise.all([
      startRouter(s.options({ spawn: fake.spawn })),
      startRouter(s.options({ spawn: fake.spawn })),
    ]);
    expect(one).toMatchObject({ ok: true });
    expect(two).toMatchObject({ ok: true });
    expect(fake.started).toHaveLength(1);

    const stale = await setup();
    mkdirSync(stale.state, { recursive: true });
    const lock = join(stale.state, "router.lock");
    writeFileSync(lock, "1\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(await startRouter(stale.options({ spawn: fakeSpawner({}).spawn }))).toMatchObject({ ok: true });
  });

  it("waits for the starter that holds a fresh lock, and errs if it never brings the router up", async () => {
    const s = await setup();
    mkdirSync(s.state, { recursive: true });
    writeFileSync(join(s.state, "router.lock"), "1\n");
    const result = await startRouter(s.options({ budgetMs: 100, spawn: fakeSpawner({}).spawn }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("holds the lock") });
  }, 10_000);

  it("retires a legacy service once the new router answers on the same port", async () => {
    const s = await setup();
    mkdirSync(join(s.home, "Library", "LaunchAgents"), { recursive: true });
    const plist = join(s.home, "Library", "LaunchAgents", "test.acme-router.plist");
    writeFileSync(plist, "<plist/>");
    const commands: string[] = [];
    const result = await startRouter(
      s.options({
        spawn: fakeSpawner({}).spawn,
        uid: 501,
        run: (bin, args) => commands.push(`${bin} ${args.join(" ")}`) > 0,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: expect.stringContaining("replaced the old launchd service"),
    });
    expect(commands).toEqual(["launchctl bootout gui/501/test.acme-router"]);
    expect(existsSync(plist)).toBe(false);

    const kept = await setup();
    mkdirSync(join(kept.home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(join(kept.home, ".config", "systemd", "user", "test.acme-router.service"), "[Unit]");
    const failed = await startRouter(
      kept.options({ spawn: fakeSpawner({ router: "dies", emergency: "dies" }).spawn, run: () => true }),
    );
    expect(failed).toMatchObject({
      ok: false,
      error: expect.stringContaining("kept the old systemd service"),
    });
  });
});

describe("the base URL guard", () => {
  it("takes the base URL off another plugin's router that is dead and unregistered, or repoints it at a live one", async () => {
    const s = await setup();
    pointSettingsAt(s, "http://127.0.0.1:18791");
    await guardBaseUrl(s.options(), true);
    expect(baseUrlIn(s)).toEqual({ OTHER: "kept" });

    const live = await freePort();
    await hold(live, (_req, res) => res.end(JSON.stringify({ ok: true, name: "kimi" })));
    pointSettingsAt(s, "http://127.0.0.1:18791");
    await saveRegistryEntry(s.env, {
      name: "kimi",
      port: live,
      modelPrefixes: [],
      catalogIds: [],
      updatedAt: "t",
    });
    await guardBaseUrl(s.options(), true);
    expect(baseUrlIn(s)).toEqual({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${live}`, OTHER: "kept" });
  });

  it("never touches a base URL that is not a plugin router, nor a registered or answering one", async () => {
    const s = await setup();
    await guardBaseUrl(s.options(), false);
    pointSettingsAt(s, "https://my-proxy.example");
    await guardBaseUrl(s.options(), false);
    expect(baseUrlIn(s)).toEqual({ ANTHROPIC_BASE_URL: "https://my-proxy.example", OTHER: "kept" });
    pointSettingsAt(s, "http://127.0.0.1:18790");
    await guardBaseUrl(s.options({ answers: async () => true }), true);
    expect(baseUrlIn(s)).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:18790", OTHER: "kept" });
    await saveRegistryEntry(s.env, {
      name: "minimax",
      port: 18790,
      modelPrefixes: [],
      catalogIds: [],
      updatedAt: "t",
    });
    await guardBaseUrl(s.options(), true);
    expect(baseUrlIn(s)).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:18790", OTHER: "kept" });
    pointSettingsAt(s, `http://127.0.0.1:${s.port}`);
    await guardBaseUrl(s.options(), true);
    expect(baseUrlIn(s)).toEqual({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${s.port}`, OTHER: "kept" });
  });
});

describe("stop, status and the key check", () => {
  it("stops only a pid that runs our bundle; a stale record just goes", async () => {
    const s = await setup();
    expect(stopRouter({ provider: ACME_PROVIDER, env: s.env, stateRoot: s.state })).toEqual({
      ok: true,
      value: "stopped (was not running)",
    });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    cleanups.push(() => child.kill("SIGKILL"));
    const record = {
      pid: child.pid as number,
      port: s.port,
      startedAt: "t",
      node: "n",
      version: "v",
      frontVersion: 1,
      mode: "router" as const,
      token: "x",
    };
    mkdirSync(s.state, { recursive: true });
    writePidFile(s.state, record);
    expect(stopRouter({ provider: ACME_PROVIDER, env: s.env, stateRoot: s.state })).toMatchObject({
      value: expect.stringContaining("is not our router"),
    });
    writePidFile(s.state, record);
    const exited = new Promise((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    expect(
      stopRouter({
        provider: ACME_PROVIDER,
        env: s.env,
        stateRoot: s.state,
        commandLine: () => "node acme-router.js run",
      }),
    ).toEqual({ ok: true, value: `stopped (pid ${child.pid})` });
    expect(await exited).toBe("SIGTERM");
    writePidFile(s.state, { ...record, pid: 2 ** 22 + 7 });
    expect(
      stopRouter({
        provider: ACME_PROVIDER,
        env: s.env,
        stateRoot: s.state,
        commandLine: () => "node acme-router.js",
      }),
    ).toEqual({ ok: true, value: "stopped (was not running)" });
    expect(readPidFile(s.state)).toBeUndefined();
  });

  it("reports the status line for each state of the port", async () => {
    const s = await setup();
    expect(await routerStatus(ACME_PROVIDER, s.env)).toEqual({
      up: false,
      line: `acme-router not running on http://127.0.0.1:${s.port}; this session does not use it`,
    });
    await hold(s.port, (req, res) =>
      res.end(
        req.url === HEALTH ? '{"ok":true,"name":"acme","provider":"Acme Models","mode":"emergency"}' : "",
      ),
    );
    expect(
      await routerStatus(ACME_PROVIDER, { ...s.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${s.port}` }),
    ).toEqual({
      up: true,
      line: `acme-router running (emergency) on http://127.0.0.1:${s.port}; this session uses it`,
    });
    const other = await setup();
    await hold(other.port, (_req, res) => res.end("x"));
    expect((await routerStatus(ACME_PROVIDER, other.env)).line).toContain("port held by another program");
  });

  it("asks the running router whether it can read the key", async () => {
    const s = await setup();
    expect(await routerKeyCheck(ACME_PROVIDER, s.env, s.state)).toEqual({
      ok: false,
      error: "no router is running",
    });
    mkdirSync(s.state, { recursive: true });
    writePidFile(s.state, {
      pid: 1,
      port: s.port,
      startedAt: "t",
      node: "n",
      version: "v",
      frontVersion: 1,
      mode: "router",
      token: "tok",
    });
    expect(await routerKeyCheck(ACME_PROVIDER, s.env, s.state)).toEqual({
      ok: false,
      error: "the router did not answer the key check",
    });
    let answer: unknown = { ok: true, source: "ACME_API_KEY" };
    let answerFn = (): unknown => answer;
    await hold(s.port, (req, res) => {
      expect(req.headers[TOKEN_HEADER]).toBe("tok");
      res.end(JSON.stringify(answerFn()));
    });
    expect(await routerKeyCheck(ACME_PROVIDER, s.env, s.state)).toEqual({ ok: true, value: "ACME_API_KEY" });
    answer = { ok: false, error: "no_key" };
    expect(await routerKeyCheck(ACME_PROVIDER, s.env, s.state)).toEqual({ ok: false, error: "no_key" });
    answer = { ok: false };
    expect(await routerKeyCheck(ACME_PROVIDER, s.env, s.state)).toEqual({
      ok: false,
      error: "the router cannot read the key",
    });
    // A router just started has no worker yet: the check waits for it, up to its budget.
    let asked = 0;
    answer = undefined;
    const starting = (): unknown =>
      ++asked < 3 ? { ok: false, error: NO_WORKER } : { ok: true, source: "ACME_API_KEY" };
    answerFn = starting;
    expect(await routerKeyCheck(ACME_PROVIDER, s.env, s.state)).toEqual({ ok: true, value: "ACME_API_KEY" });
    expect(asked).toBe(3);
    asked = 0;
    answerFn = () => ({ ok: false, error: NO_WORKER });
    expect(await routerKeyCheck(ACME_PROVIDER, s.env, s.state, 250)).toEqual({ ok: false, error: NO_WORKER });
  });
});

it("finds a free loopback port", async () => {
  const port = await freePort();
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  server.close();
});
