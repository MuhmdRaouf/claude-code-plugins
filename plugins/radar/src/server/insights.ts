/**
 * Everything the dashboard derives beyond the raw store, wired once per server: the usage ledger (fed from the
 * store), budgets and their status file, the alerts engine with dismissals, desktop notifications, attribution,
 * router health, the model advisor and the metrics text. A timer ticks every 10 s to flush the ledger, rewrite
 * budget-status.json (so routers always see a fresh updatedAt) and notify about new alerts. Nothing here blocks or
 * throws into the request path: a broken file is the defaults, a failed write is retried on the next tick.
 */
import { type Alert, DEFAULT_THRESHOLDS, detectAlerts, type Thresholds } from "../alerts/engine.ts";
import { createNotifier, type Notifier, type Runner } from "../alerts/notify.ts";
import {
  type Budget,
  type BudgetStatus,
  computeStatus,
  readBudgets,
  validateBudgets,
  writeBudgets,
  writeStatus,
} from "../budget/budgets.ts";
import { type AdvisorReport, advise } from "../cost/advisor.ts";
import {
  type AttributionBy,
  type AttributionNode,
  type AttributionRange,
  type AttributionRow,
  attribute,
  attributionTree,
  rangeStart,
  spendSince,
} from "../cost/attribution.ts";
import { createLedger, LEDGER_DAYS, type Ledger } from "../cost/ledger.ts";
import { KNOWN_PLUGINS, pluginOf } from "../cost/prices.ts";
import { type RouterHealth, routerHealth } from "../router/health.ts";
import type { Store } from "../store/store.ts";
import { renderMetrics } from "./metrics.ts";
import {
  readDismissed,
  readSettings,
  type Settings,
  validateSettings,
  writeDismissed,
  writeSettings,
} from "./settings.ts";

export type Insights = {
  ledger: Ledger;
  /** Active alerts the user has not dismissed. */
  alerts(): Alert[];
  dismiss(id: string): boolean;
  budgets(): Budget[];
  setBudgets(input: unknown): Budget[] | string;
  budgetStatus(): BudgetStatus;
  settings(): Settings;
  setSettings(input: unknown): Settings | string;
  attribution(by: AttributionBy, range: AttributionRange): AttributionRow[];
  /** The costs drill-down over the same rows: repos → sessions → agents → models. */
  tree(range: AttributionRange): AttributionNode[];
  /** Estimated spend since local midnight (null when nothing today is priced). */
  spendToday(): number | null;
  /** The provider plugins with requests in the ledger, plus the known ones. */
  providers(): string[];
  routerHealth(): RouterHealth;
  advisor(): AdvisorReport;
  metrics(version: string): string;
  tick(): void;
  stop(): void;
};

export type InsightsOptions = {
  env: NodeJS.ProcessEnv;
  store: Store;
  now?: () => number;
  /** 0 disables the timer (tests call tick() themselves). */
  tickMs?: number;
  notifier?: Notifier;
  runner?: Runner;
  thresholds?: Thresholds;
};

const ALERT_CACHE_MS = 2000;

export function createInsights(options: InsightsOptions): Insights {
  const { env, store } = options;
  const now = options.now ?? Date.now;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const ledger = createLedger(env, now);
  let budgets = readBudgets(env);
  let settings = readSettings(env);
  const dismissed = readDismissed(env, now());
  const notifier =
    options.notifier ??
    createNotifier({
      env,
      enabled: () => settings.notifications,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      now,
    });
  let alertCache: { at: number; version: number; ledger: number; alerts: Alert[] } | null = null;
  /** Advisor and metrics text per store version: each call used to copy the whole store, so a
   *  Prometheus scrape or a repeated advisor view cost a few MB of records for the same answer. */
  let advisorCache: { version: number; report: AdvisorReport } | null = null;
  let metricsCache: { version: number; ledger: number; forVersion: string; text: string } | null = null;
  const namedAgents = new Set<string>();

  for (const request of store.requestsFor({})) ledger.record(request);
  const unsubscribe = store.onUpdate((change) => {
    for (const request of change.requests) ledger.record(request);
  });

  function ledgerRows(): ReturnType<Ledger["rows"]> {
    return ledger.rows(now() - LEDGER_DAYS * 86_400_000);
  }

  function status(): BudgetStatus {
    return computeStatus(budgets, ledgerRows(), now());
  }

  function cachedAlerts(at: number): Alert[] | null {
    if (alertCache === null || at - alertCache.at >= ALERT_CACHE_MS) return null;
    const same = alertCache.version === store.version() && alertCache.ledger === ledger.version();
    return same ? alertCache.alerts : null;
  }

  function allAlerts(): Alert[] {
    const at = now();
    const cached = cachedAlerts(at);
    if (cached !== null) return cached;
    const raw = store.raw();
    const alerts = detectAlerts(
      {
        now: at,
        sessions: store.sessionList(),
        requests: raw.requests,
        tools: raw.tools,
        events: raw.events,
        apiErrors: store.apiErrors(),
        budgets: budgets.length === 0 ? [] : status().spend,
      },
      thresholds,
    );
    alertCache = { at, version: store.version(), ledger: ledger.version(), alerts };
    return alerts;
  }

  /** Remember what sessions and agents are called, so old ledger rows keep a readable label. */
  function nameThings(): void {
    for (const session of store.sessionList()) {
      ledger.nameSession(session.id, {
        project: session.project,
        title: session.title,
        repo: session.repo,
        parentSessionId: session.parentSessionId,
        name: session.name,
      });
      if (!session.live && namedAgents.has(session.id)) continue;
      namedAgents.add(session.id);
      nameAgents(session.id);
    }
  }

  function nameAgents(sessionId: string): void {
    for (const agent of store.sessionDetail(sessionId)?.agents ?? []) {
      const named = agent.name !== null && agent.name !== agent.id;
      if (agent.id !== "main" && named)
        ledger.nameAgent(sessionId, agent.id, {
          name: agent.name ?? agent.id,
          type: agent.agentType,
          description: agent.description,
        });
    }
  }

  function tick(): void {
    try {
      nameThings();
      ledger.flush();
      if (budgets.length > 0) writeStatus(env, status());
      notifier.consider(allAlerts());
    } catch {
      // the next tick tries again; the dashboard keeps serving either way
    }
  }

  /** The ledger's names, with what the store knows right now laid over them (it may not have ticked yet). */
  function names(): ReturnType<Ledger["names"]> {
    const known = ledger.names();
    for (const session of store.sessionList()) {
      const previous = known.sessions[session.id];
      known.sessions[session.id] = {
        project: session.project ?? previous?.project ?? null,
        title: session.title ?? previous?.title ?? null,
        repo: session.repo ?? previous?.repo ?? null,
        parentSessionId: session.parentSessionId ?? previous?.parentSessionId ?? null,
        name: session.name ?? previous?.name ?? null,
      };
    }
    return known;
  }

  tick(); // names, the ledger file and budget-status.json are there from the first moment
  const timer = options.tickMs === 0 ? null : setInterval(tick, options.tickMs ?? 10_000);
  timer?.unref();

  return {
    ledger,
    alerts: () => allAlerts().filter((alert) => !dismissed.has(alert.id)),
    dismiss(id) {
      if (typeof id !== "string" || id === "" || id.length > 300) return false;
      dismissed.set(id, now());
      try {
        writeDismissed(env, dismissed);
      } catch {
        // dismissed for this run; the file catches up on the next dismissal
      }
      return true;
    },
    budgets: () => budgets,
    setBudgets(input) {
      const next = validateBudgets(input);
      if (typeof next === "string") return next;
      writeBudgets(env, next);
      budgets = next;
      alertCache = null;
      metricsCache = null;
      writeStatus(env, status());
      return next;
    },
    budgetStatus: status,
    settings: () => settings,
    setSettings(input) {
      const next = validateSettings(input, settings);
      if (typeof next === "string") return next;
      writeSettings(env, next);
      settings = next;
      return next;
    },
    attribution: (by, range) => attribute(ledgerRows(), by, names(), rangeStart(range, now())),
    tree: (range) => attributionTree(ledgerRows(), names(), rangeStart(range, now())),
    spendToday: () => spendSince(ledgerRows(), rangeStart("day", now())),
    providers() {
      const seen = new Set<string>(KNOWN_PLUGINS);
      for (const row of ledgerRows()) {
        const plugin = pluginOf(row.model);
        if (plugin !== null) seen.add(plugin);
      }
      for (const event of store.routerEvents()) seen.add(event.plugin);
      return [...seen];
    },
    routerHealth: () => routerHealth(store.routerEvents(), now()),
    advisor() {
      const held = advisorCache;
      if (held !== null && held.version === store.version()) return held.report;
      const raw = store.raw();
      const report = advise(raw.requests, raw.tools);
      advisorCache = { version: store.version(), report };
      return report;
    },
    metrics(version) {
      const held = metricsCache;
      if (
        held !== null &&
        held.forVersion === version &&
        held.version === store.version() &&
        held.ledger === ledger.version()
      ) {
        return held.text;
      }
      const raw = store.raw();
      const text = renderMetrics({
        version,
        ledger: ledgerRows(),
        names: names(),
        requests: raw.requests,
        tools: raw.tools,
        apiErrors: store.apiErrors(),
        routerEvents: store.routerEvents(),
        alerts: allAlerts(),
        sessions: store.sessionList(),
        budgets: status().spend,
      });
      metricsCache = { version: store.version(), ledger: ledger.version(), forVersion: version, text };
      return text;
    },
    tick,
    stop() {
      if (timer !== null) clearInterval(timer);
      unsubscribe();
      ledger.flush();
    },
  };
}
