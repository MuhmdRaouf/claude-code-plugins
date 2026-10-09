/**
 * The whole dashboard: a glass top bar over a neon line, the view tabs, and the active view beside the
 * sessions rail — every page opening with its PageIntro (what it shows, what to do with it) before its
 * panels. While the first snapshot is on its way, both columns show skeletons instead of blank space.
 */

import { PageIntro } from "@muhmdraouf/ui/page.tsx";
import type { ComponentType } from "preact";
import { fmtNum } from "../fmt.ts";
import type { IconName } from "../icons.ts";
import type { Tab } from "../state.ts";
import { TABS } from "../state.ts";
import { AgentTranscript } from "./AgentTranscript.tsx";
import { AlertStrip } from "./AlertStrip.tsx";
import { Banner } from "./Banner.tsx";
import { useApp } from "./context.ts";
import { Drawer } from "./Drawer.tsx";
import { Flow } from "./Flow.tsx";
import { Icon } from "./Icon.tsx";
import { Rail } from "./Rail.tsx";
import { ScopeHeader } from "./ScopeHeader.tsx";
import { BudgetCard, StatCards } from "./StatCards.tsx";
import { AgentsView } from "./views/Agents.tsx";
import { AlertsView } from "./views/Alerts.tsx";
import { CostsView } from "./views/Costs.tsx";
import { ModelsView } from "./views/Models.tsx";
import { RequestsView } from "./views/Requests.tsx";
import { RouterView } from "./views/Router.tsx";
import { SessionAgentsView } from "./views/SessionAgents.tsx";
import { SettingsView } from "./views/Settings.tsx";
import { TimelineView } from "./views/Timeline.tsx";
import { ToolsView } from "./views/Tools.tsx";

const VIEWS: Record<Tab, ComponentType> = {
  overview: OverviewView,
  agents: AgentsView,
  requests: RequestsView,
  tools: ToolsView,
  timeline: TimelineView,
  models: ModelsView,
  costs: CostsView,
  alerts: AlertsView,
  router: RouterView,
  settings: SettingsView,
};

/** The default view: the alert strip, the summary cards, the budget bars and the token flow. */
function OverviewView() {
  return (
    <div class="grid gap-5">
      <AlertStrip />
      <StatCards />
      <BudgetCard />
      <Flow />
    </div>
  );
}

/** The three tab groups, side by side: reading (Activity), money (Spend), and the machinery (System). */
const NAV_GROUPS: { label: string; tabs: Tab[] }[] = [
  { label: "Activity", tabs: ["overview", "requests", "agents", "tools", "timeline"] },
  { label: "Spend", tabs: ["models", "costs"] },
  { label: "System", tabs: ["alerts", "router", "settings"] },
];

/** What every tab opens with: the one sentence on what it shows and what the reader can do here. */
const PAGE_INTROS: Record<Tab, string> = {
  overview:
    "The big picture for the sessions you are viewing: spend, tokens, live agents, alerts and the token flow over time. Pick sessions on the left to narrow it, click them again to widen.",
  requests:
    "Every API call, newest first. Filter by model, click a row to open its full input, output, tokens and cost; J and K step through requests while it is open.",
  agents:
    "Every main agent and subagent: what it ran on, how many requests and tokens it used, what it cost and whether anything failed. Expand a session to see its agents; click one to watch its transcript live.",
  tools: "Tool calls the agents made: which tool, how long it took and whether it worked.",
  timeline: "What happened, in order: sessions starting and ending, agents spawning, compactions and errors.",
  models: "Requests, tokens, latency and cost for each model, side by side.",
  costs: "Where the money goes, from repo down to session, agent and model. Estimates use list prices.",
  alerts: "Things that need a look: context nearly full, failures, slow requests and budgets crossed.",
  router: "The local model router: whether it is healthy, where it sends each model, and recent retries.",
  settings: "Appearance, budgets, history retention and where Radar reads its data.",
};

/** One tab: its icon, its label, the alerts count on the Alerts tab, the glow when it is the current one. */
function ViewTab({
  id,
  label,
  icon,
  active,
  alerts,
}: {
  id: Tab;
  label: string;
  icon: IconName;
  active: boolean;
  alerts: number;
}) {
  const { act } = useApp();
  return (
    <button
      type="button"
      role="tab"
      class={
        active
          ? "tab tab-active h-10 gap-2 px-4 neon-text text-[0.9375rem]"
          : "tab h-10 gap-2 px-4 text-[0.9375rem]"
      }
      data-action="tab"
      data-value={id}
      aria-selected={active ? "true" : "false"}
      aria-current={active ? "page" : undefined}
      onClick={() => act("tab", id)}
    >
      <Icon name={icon} class="size-4.5" />
      <span>{label}</span>
      {id === "alerts" && alerts > 0 && <span class="badge badge-error badge-sm">{fmtNum(alerts)}</span>}
    </button>
  );
}

/** The one row of tab groups under the top bar: three daisyUI tabs boxes with a gap, the active tab
 *  glowing. Tab ids, the URL hash and the tablist roles stay as they were. */
function ViewTabs() {
  const { state } = useApp();
  return (
    <div class="mx-auto flex w-full max-w-[1600px] flex-wrap gap-3 px-8 pt-5 max-sm:px-4" data-view-tabs="">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} role="tablist" aria-label={group.label} class="tabs tabs-box">
          {group.tabs.map((id) => {
            const tab = TABS.find((entry) => entry.id === id);
            return tab === undefined ? null : (
              <ViewTab
                key={id}
                id={id}
                label={tab.label}
                icon={tab.icon}
                active={state.tab === id}
                alerts={state.alerts.length}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Skeletons shaped like the overview, shown until the first snapshot arrives. */
function Connecting() {
  return (
    <div class="grid gap-5" aria-live="polite">
      <p class="muted text-row">
        Connecting to the radar server. The first snapshot arrives in a moment; the live stream attaches right
        after.
      </p>
      <div class="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((card) => (
          <div key={card} class="skeleton h-24" />
        ))}
      </div>
      <div class="skeleton h-64" />
    </div>
  );
}

export function App() {
  const { state } = useApp();
  // a picked session's Agents tab is that session's own table, not the fleet's per-session blocks
  const View = state.tab === "agents" && state.session !== null ? SessionAgentsView : VIEWS[state.tab];
  const label = TABS.find((entry) => entry.id === state.tab)?.label ?? "View";
  const intro = PAGE_INTROS[state.tab];
  const icon = TABS.find((entry) => entry.id === state.tab)?.icon ?? "gauge";
  return (
    <>
      <div class="drawer lg:drawer-open">
        <input id="radar-rail" type="checkbox" class="drawer-toggle" />
        <div class="drawer-content flex min-w-0 flex-col">
          <ScopeHeader />
          <ViewTabs />
          <main
            data-view
            aria-label={label}
            class="mx-auto w-full max-w-[1600px] flex-1 px-8 py-6 max-sm:px-4"
          >
            {state.error !== null && <Banner message={state.error} />}
            <PageIntro icon={<Icon name={icon} />} title={label} description={intro} />
            {state.summary === null ? <Connecting /> : <View />}
          </main>
        </div>
        <div class="drawer-side">
          <label for="radar-rail" aria-label="Close the sessions rail" class="drawer-overlay" />
          <Rail />
        </div>
      </div>
      <Drawer />
      <AgentTranscript />
    </>
  );
}
