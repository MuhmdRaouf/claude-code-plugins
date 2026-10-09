import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { SessionView } from "../../src/shared/model.ts";
import { ZERO_TOKENS } from "../../src/shared/model.ts";
import { SessionAgentsView } from "../../src/ui/app/views/SessionAgents.tsx";
import { renderApp } from "./render.tsx";

function detail(agents: SessionView["agents"]): SessionView {
  return {
    id: "s1",
    cwd: null,
    project: "app",
    name: "Fleet sweep",
    branch: null,
    repo: null,
    parentSessionId: null,
    startedAt: null,
    endedAt: null,
    live: true,
    status: null,
    activity: {
      bucketMs: 18_750,
      counts: new Array<number>(48).fill(0),
      models: new Array<string>(48).fill(""),
    },
    model: null,
    upstream: "",
    ccVersion: null,
    requestCount: 4,
    errorCount: 0,
    toolCount: 0,
    tokens: { ...ZERO_TOKENS },
    agents,
    liveAgentCount: 0,
    external: false,
  };
}

function agent(over: Partial<SessionView["agents"][number]> = {}): SessionView["agents"][number] {
  return {
    id: "main",
    sessionId: "s1",
    parentId: null,
    kind: "main",
    name: "main",
    agentType: null,
    description: null,
    model: "claude-sonnet-5-5",
    requests: 3,
    errors: 0,
    tools: 1,
    tokens: { ...ZERO_TOKENS },
    live: true,
    lastAt: 1_800_000_000_000,
    ...over,
  };
}

const NOW = 1_800_000_000_000;

describe("SessionAgentsView", () => {
  it("renders one table with Main first, then the subagent, then the jobs section", () => {
    const { container } = renderApp(
      <SessionAgentsView />,
      {
        session: "s1",
        sessions: [{ ...sessionItem() }],
        details: {
          s1: detail([
            agent(),
            agent({
              id: "a1",
              parentId: "main",
              kind: "subagent",
              name: null,
              agentType: "fork",
              description: "dig",
              live: false,
              lastAt: NOW - 300_000,
              requests: 1,
            }),
            agent({ id: "zai:one", kind: "external", name: "One", live: true, requests: 1 }),
          ]),
        },
      },
      NOW,
    );
    expect(container.querySelector('[data-key="session-agents"]')).toBeTruthy();
    expect(container.textContent).toContain("Jobs (1)");
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows[0]?.textContent).toContain("Main");
    expect(rows[1]?.textContent).toContain("dig");
    expect(rows[1]?.className).toContain("opacity-60"); // ended, dimmed
    expect(rows[2]?.textContent).toContain("Jobs (1)"); // the section between the locals and the jobs
    expect(rows[3]?.textContent).toContain("One");
    expect(container.textContent).toContain("3 agents");
  });

  it("opens the agent's live transcript on click, keeps the narrowed row lit, and ignores the fold chevron", async () => {
    const { act, container } = renderApp(
      <SessionAgentsView />,
      {
        session: "s1",
        sessions: [{ ...sessionItem() }],
        details: {
          s1: detail([
            agent(),
            agent({ id: "a1", parentId: "main", kind: "subagent", name: "digger", description: null }),
          ]),
        },
      },
      NOW,
    );
    const row = container.querySelector("tbody tr");
    await userEvent.click(row as HTMLElement);
    expect(act).toHaveBeenCalledWith("agent-transcript", "s1/main");
    // a narrowed agent's row stays lit while its transcript shows
    const picked = renderApp(
      <SessionAgentsView />,
      {
        session: "s1",
        agent: "a1",
        sessions: [{ ...sessionItem() }],
        details: {
          s1: detail([
            agent(),
            agent({ id: "a1", parentId: "main", kind: "subagent", name: "digger", description: null }),
          ]),
        },
      },
      NOW,
    );
    expect(picked.container.querySelector('tr[class*="bg-primary"]')).toBeTruthy();
    await userEvent.click(picked.container.querySelector('tr[class*="bg-primary"]') as HTMLElement);
    expect(picked.act).toHaveBeenCalledWith("agent-transcript", "s1/a1");
    // the fold chevron folds without opening the transcript
    act.mockClear();
    const toggle = container.querySelector('button[data-action="collapse"]') as HTMLElement;
    await userEvent.click(toggle);
    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith("collapse", "s1/main");
  });

  it("says the detail is loading, and that a session has no agents yet", () => {
    const loading = renderApp(
      <SessionAgentsView />,
      { session: "s1", sessions: [{ ...sessionItem() }] },
      NOW,
    );
    expect(loading.container.textContent).toContain("Loading this session's agents…");
    loading.unmount();
    renderApp(
      <SessionAgentsView />,
      { session: "s1", sessions: [{ ...sessionItem() }], details: { s1: detail([]) } },
      NOW,
    );
    expect(screen.getByText("No agents yet")).toBeTruthy();
  });
});

function sessionItem() {
  return {
    id: "s1",
    project: "app",
    cwd: null,
    name: null,
    branch: null,
    repo: null,
    parentSessionId: null,
    startedAt: null,
    endedAt: null,
    live: true,
    status: null,
    activity: {
      bucketMs: 18_750,
      counts: new Array<number>(48).fill(0),
      models: new Array<string>(48).fill(""),
    },
    model: null,
    agentCount: 1,
    liveAgentCount: 0,
    requestCount: 4,
    tokens: 0,
    lastAt: 0,
    external: false,
    title: null,
  };
}
