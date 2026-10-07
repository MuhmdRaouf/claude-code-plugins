#!/usr/bin/env node
import { createRequire as __zaiCreateRequire } from "node:module";
const require = __zaiCreateRequire(import.meta.url);

// src/router/ensure.ts
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";

// ../../node_modules/@muhmdraouf/core/src/router/ensure.ts
import { existsSync } from "node:fs";

// ../../node_modules/@muhmdraouf/core/src/adapters/process/detached.ts
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
function startDetached(command, args, options = {}) {
  let out = "ignore";
  if (options.logFile !== void 0) {
    try {
      out = openSync(options.logFile, "a", 384);
    } catch {
      out = "ignore";
    }
  }
  const child = spawn(command, [...args], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    ...options.env === void 0 ? {} : { env: options.env },
    ...options.verbatim ? { windowsVerbatimArguments: true } : {}
  });
  if (typeof out === "number") closeSync(out);
  child.on("error", () => void 0);
  child.unref();
  return {
    pid: child.pid,
    exited: () => child.exitCode !== null || child.signalCode !== null,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }
  };
}

// ../../node_modules/@muhmdraouf/core/src/adapters/process/port.ts
import net from "node:net";
function portAnswers(port, ms) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (answered) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(ms, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// ../../node_modules/@muhmdraouf/core/src/adapters/state-root.ts
import { homedir } from "node:os";
import { basename, join } from "node:path";
function resolveStateRoot(env, rule) {
  const explicit = env[rule.envVar];
  if (explicit) return explicit;
  if (env.CLAUDE_PLUGIN_DATA && basename(env.CLAUDE_PLUGIN_DATA).startsWith(rule.dataPrefix))
    return env.CLAUDE_PLUGIN_DATA;
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, rule.xdgName);
  return join(env.HOME ?? homedir(), ".local", "state", rule.xdgName);
}
function stateRootRule(provider) {
  return {
    envVar: `${provider.envPrefix}_STATE_DIR`,
    dataPrefix: `${provider.name}-`,
    xdgName: provider.name
  };
}

// ../../node_modules/@muhmdraouf/core/src/domain/state-layout.ts
import { dirname, join as join2 } from "node:path";
var ENGINE_PID = "engine.pid";
function stateLayout(root) {
  const routerDir = join2(root, "router");
  const jobs = join2(root, "jobs");
  const checkouts = join2(root, "checkouts");
  return {
    root,
    setupDone: join2(root, "setup-done"),
    legacyRouteMark: join2(root, "route"),
    engines: join2(root, "engines.json"),
    ledger: join2(root, "ledger.json"),
    disabledLedger: join2(root, "ledger.disabled.json"),
    routerDir,
    routerLog: join2(routerDir, "router.log"),
    routerPid: join2(root, "router.pid"),
    routerLock: join2(root, "router.lock"),
    crashLog: join2(root, "router-crash.log"),
    leftBehind: join2(root, "LEFT-BEHIND.md"),
    claudeHome: join2(root, "claude-home"),
    limiter: join2(root, "limiter.json"),
    slots: join2(root, "slots"),
    jobs,
    checkouts,
    job(id) {
      const dir = join2(jobs, id);
      return {
        dir,
        record: join2(dir, "job.json"),
        brief: join2(dir, "brief.md"),
        artifacts: join2(dir, "artifacts"),
        attemptLog: (n) => join2(dir, `attempt-${n}.jsonl`),
        gateLog: (n, gate) => join2(dir, `gate-${n}-${gate}.log`),
        regenerateLog: (n) => join2(dir, `regenerate-${n}.log`),
        landCheckLog: (n) => join2(dir, `land-check-${n}.log`),
        driverLog: join2(dir, "driver.log"),
        stop: join2(dir, "stop"),
        progress: join2(dir, "progress.json"),
        driverLock: join2(dir, "driver.lock"),
        enginePid: join2(dir, ENGINE_PID),
        worktree: join2(root, "worktrees", id),
        checkout: join2(checkouts, id)
      };
    }
  };
}

// ../../node_modules/@muhmdraouf/core/src/router/ensure.ts
async function ensureRouter(options) {
  const { env } = options;
  const root = resolveStateRoot(env, stateRootRule(options));
  if (!existsSync(stateLayout(root).setupDone) && !existsSync(stateLayout(root).routerPid)) return "skipped";
  const port = Number(env[`${options.envPrefix}_ROUTER_PORT`]) || options.defaultPort;
  if (await portAnswers(port, options.connectMs ?? 100)) return "up";
  const start = options.start ?? ((node, args, startEnv) => void startDetached(node, args, { env: startEnv }));
  start(options.node ?? process.execPath, [options.routerScript, "start"], env);
  return "started";
}

// ../../node_modules/@muhmdraouf/core/src/domain/provider.ts
function defineProvider(spec) {
  return { ...spec, agents: { main: spec.catalog.main.id, flash: spec.catalog.flash.id } };
}

// src/provider.ts
var ZAI_PROVIDER = defineProvider({
  name: "zai",
  display: "Z.ai GLM",
  slash: "/zai:",
  agentPrefix: "zai:",
  branchPrefix: "zai/",
  harness: "zai",
  artifactsEnv: "ZAI_ARTIFACTS",
  envPrefix: "ZAI",
  catalog: {
    main: { tier: "main", id: "glm-5.3", label: "GLM 5.3" },
    flash: { tier: "flash", id: "glm-5.3-flash", label: "GLM 5.3 Flash" }
  },
  tierNames: { main: "glm", flash: "flash" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "flash",
  workerLabel: "claude",
  baseUrl: { intl: "https://api.z.ai/api/anthropic", cn: "https://open.bigmodel.cn/api/anthropic" },
  auth: "bearer",
  keyEnv: ["ZAI_API_KEY"],
  keyFile: "~/.config/zai-plugin-cc/env",
  billingUrl: "https://z.ai/manage-apikey/billing",
  strip: [],
  caveats: [],
  router: {
    port: 18787,
    label: "dev.muhmdraouf.zai-router",
    healthPath: "/zai-router/health",
    modelPrefixes: ["glm-"]
  }
});

// src/router/ensure.ts
try {
  await ensureRouter({
    name: ZAI_PROVIDER.name,
    envPrefix: ZAI_PROVIDER.envPrefix,
    defaultPort: ZAI_PROVIDER.router.port,
    env: process.env,
    routerScript: join3(dirname2(fileURLToPath(import.meta.url)), "zai-router.js")
  });
} catch {
}
process.exit(0);
