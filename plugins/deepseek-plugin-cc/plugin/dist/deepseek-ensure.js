#!/usr/bin/env node
import { createRequire as __deepseekCreateRequire } from "node:module";
const require = __deepseekCreateRequire(import.meta.url);

// src/router/ensure.ts
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";

// ../../node_modules/@muhmdraouf/core/src/router/ensure.ts
import { existsSync as existsSync2 } from "node:fs";

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
import { basename } from "node:path";

// ../../node_modules/@muhmdraouf/core/src/adapters/state-migrate.ts
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function legacyStateDir(env, name) {
  return join(env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state"), name);
}
function agentsStateDir(env, name) {
  return join(env.HOME ?? homedir(), ".agents", name);
}
function lostRace(error) {
  const code = error.code;
  return code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY";
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function occupied(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function entriesOf(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return void 0;
  }
}
function migrateStateDir(name, env, log = console.error) {
  const from = legacyStateDir(env, name);
  const to = agentsStateDir(env, name);
  if (from === to || !existsSync(from)) return;
  try {
    mkdirSync(to, { recursive: true, mode: 448 });
  } catch (error) {
    log(`state migrate: cannot create ${to} (${messageOf(error)}); ${name}'s state stays in ${from}`);
    return;
  }
  if (moveEntries(name, from, to, log)) return;
  settleOldDir(from, to, log);
}
function moveEntries(name, from, to, log) {
  for (const entry of entriesOf(from) ?? []) {
    if (occupied(join(to, entry))) continue;
    try {
      renameSync(join(from, entry), join(to, entry));
    } catch (error) {
      if (lostRace(error)) continue;
      log(
        `state migrate: cannot move ${join(from, entry)} (${messageOf(error)}); ${name}'s state stays in ${from}`
      );
      return true;
    }
  }
  return false;
}
function settleOldDir(from, to, log) {
  const left = entriesOf(from);
  if (left === void 0) return;
  if (left.length === 0) {
    try {
      rmdirSync(from);
    } catch {
    }
    return;
  }
  log(`state migrate: ${left.join(", ")} left in ${from} because ${to} already had entries of those names`);
}

// ../../node_modules/@muhmdraouf/core/src/adapters/state-root.ts
function resolveStateRoot(env, rule, log = console.error) {
  const explicit = env[rule.envVar];
  if (explicit) return explicit;
  if (env.CLAUDE_PLUGIN_DATA && basename(env.CLAUDE_PLUGIN_DATA).startsWith(rule.dataPrefix))
    return env.CLAUDE_PLUGIN_DATA;
  migrateStateDir(rule.xdgName, env, log);
  return agentsStateDir(env, rule.xdgName);
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
    routerRetired: join2(root, "router.retired"),
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
  if (!existsSync2(stateLayout(root).setupDone) && !existsSync2(stateLayout(root).routerPid)) return "skipped";
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
var DEEPSEEK_PROVIDER = defineProvider({
  name: "deepseek",
  display: "DeepSeek",
  slash: "/deepseek:",
  agentPrefix: "deepseek:",
  branchPrefix: "deepseek/",
  harness: "deepseek",
  artifactsEnv: "DEEPSEEK_ARTIFACTS",
  envPrefix: "DEEPSEEK",
  catalog: {
    main: {
      tier: "main",
      id: "deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
      behavesAs: "claude-opus-5-5",
      maxOutputTokens: 393216,
      defaultEffort: "xhigh"
    },
    flash: {
      tier: "flash",
      id: "deepseek-flash",
      label: "DeepSeek Flash",
      behavesAs: "claude-opus-5-5",
      maxOutputTokens: 393216,
      defaultEffort: "xhigh"
    }
    // DeepSeek's published figures (2026-10-09, https://api-docs.deepseek.com/quick_start/pricing): both models
    // carry a 1M context length and a "MAXIMUM: 384K" output, and run in thinking mode by default.
  },
  tierNames: { main: "deepseek", flash: "flash" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "flash",
  workerLabel: "claude",
  baseUrl: "https://api.deepseek.com/anthropic",
  auth: "bearer",
  keyEnv: ["DEEPSEEK_API_KEY"],
  keyFile: "~/.config/deepseek-plugin-cc/env",
  billingUrl: "https://platform.deepseek.com/top_up",
  keysUrl: "https://platform.deepseek.com/api_keys",
  strip: ["cache_control"],
  caveats: ["DeepSeek ignores cache_control"],
  router: {
    port: 18789,
    label: "com.muhmdraouf.deepseek-router",
    healthPath: "/deepseek-router/health",
    modelPrefixes: ["deepseek-"]
  }
});

// src/router/ensure.ts
try {
  await ensureRouter({
    name: DEEPSEEK_PROVIDER.name,
    envPrefix: DEEPSEEK_PROVIDER.envPrefix,
    defaultPort: DEEPSEEK_PROVIDER.router.port,
    env: process.env,
    routerScript: join3(dirname2(fileURLToPath(import.meta.url)), "deepseek-router.js")
  });
} catch {
}
process.exit(0);
