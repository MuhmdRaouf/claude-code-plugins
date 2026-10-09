import { describe, expect, it } from "vitest";
import type { Activity } from "../../src/shared/model.ts";
import { ACTIVITY_BUCKETS } from "../../src/shared/model.ts";
import { ActivityStrip, activityTotal, stripBars } from "../../src/ui/app/ActivityStrip.tsx";
import {
  type CardSession,
  cardOfSession,
  contextGauge,
  liveSubagents,
  modelsOf,
  pathParts,
  SessionCard,
  statusBar,
  worktreeName,
} from "../../src/ui/app/SessionCard.tsx";
import { renderApp } from "./render.tsx";

const NOW = 1_800_000_000_000;

const QUIET: Activity = {
  bucketMs: 18_750,
  counts: new Array<number>(48).fill(0),
  models: new Array<string>(48).fill(""),
};

function activity(counts: number[], models: string[]): Activity {
  return {
    bucketMs: 18_750,
    counts: [...counts, ...new Array<number>(48 - counts.length).fill(0)],
    models: [...models, ...new Array<string>(48 - models.length).fill("")],
  } satisfies Activity;
}

function card(over: Partial<CardSession> = {}): CardSession {
  return {
    id: "s1",
    name: "Fleet sweep",
    repo: null,
    cwd: null,
    branch: null,
    status: "working",
    live: true,
    costUsd: null,
    models: [],
    liveAgents: 0,
    agentCount: 0,
    startedAt: null,
    endedAt: null,
    lastAt: NOW - 20_000,
    now: null,
    context: null,
    activity: QUIET,
    ...over,
  };
}

describe("activity strips", () => {
  it("draw one bar per bucket, at least 2px tall, scaled against the busiest bucket", () => {
    const bars = stripBars(activity([1, 3, 0], ["glm-5.3", "claude-opus-5-5", ""]));
    expect(bars).toHaveLength(48);
    expect(bars[0]).toMatchObject({ x: 0, width: 3, height: 7, baseline: false });
    expect(bars[1]).toMatchObject({ x: 4, height: 20, baseline: false });
    expect(bars[2]).toMatchObject({ x: 8, y: 19, height: 1, baseline: true });
    expect(bars[3]).toMatchObject({ x: 12, y: 19, height: 1, baseline: true });
    // a quiet bucket next to a busy one is never an invisible bar
    expect(stripBars(activity([1, 49], []))[0]).toMatchObject({ height: 2, baseline: false });
  });

  it("colour a busy bucket by its model and the empty baseline by the theme's content colour", () => {
    const bars = stripBars(activity([1], ["glm-5.3"]));
    expect(bars[0]?.fill).toBe("var(--model-glm)");
    expect(bars[1]?.fill).toBe("var(--color-base-content)");
    // a busy bucket whose model never arrived still gets a colour, never none
    expect(stripBars(activity([2, 1], ["", "kimi-k2"]))[0]?.fill).toBe("var(--model-other)");
  });

  it("count the requests the label names and stay quiet on an empty strip", () => {
    expect(activityTotal(activity([2, 3], []))).toBe(5);
    expect(activityTotal(QUIET)).toBe(0);
  });

  it("cap the buckets they read at 48, whatever arrived", () => {
    const long: Activity = {
      bucketMs: 1,
      counts: new Array<number>(60).fill(1),
      models: new Array<string>(60).fill("glm-5.3"),
    };
    expect(stripBars(long)).toHaveLength(48);
    expect(activityTotal(long)).toBe(48);
  });

  it("render as nothing but the bars: 20px tall, no border, no rounded box, no background", () => {
    const { unmount } = renderApp(<ActivityStrip activity={QUIET} window="in the last 15 minutes" />);
    const svg = document.querySelector("svg[role='img']");
    expect(svg).not.toBeNull();
    const element = svg as SVGElement;
    const classes = (element.className.baseVal !== undefined ? element.className.baseVal : "").split(" ");
    // `block` too: legacy.css's inspector `.block` would draw its faint rounded outline around the bars
    for (const bare of ["border", "rounded-box", "rounded", "input", "skeleton", "block"]) {
      expect(classes).not.toContain(bare);
    }
    for (const bare of classes) {
      expect(bare.startsWith("bg-")).toBe(false); // no field behind the bars, only the baseline
    }
    expect(element.getAttribute("style")?.replace(/\s/g, "")).toContain("height:20px");
    expect(element.getAttribute("viewBox")).toBe(`0 0 ${ACTIVITY_BUCKETS * 4 - 1} 20`);
    const rects = [...document.querySelectorAll("svg[role='img'] rect")];
    expect(rects).toHaveLength(ACTIVITY_BUCKETS);
    // the empty strip is the 1px baseline alone, the theme's content colour at a tenth
    for (const rect of rects) {
      expect(rect.getAttribute("height")).toBe("1");
      expect(rect.getAttribute("fill")).toBe("var(--color-base-content)");
      expect(rect.getAttribute("fill-opacity")).toBe("0.1");
      expect(rect.getAttribute("stroke")).toBeNull(); // bars and baseline only, never a frame
      expect(rect.getAttribute("rx")).toBeNull();
    }
    unmount();
  });
});

describe("session helpers", () => {
  it("read the models a session used from its activity, busiest first, each once", () => {
    expect(modelsOf(activity([1, 5, 2], ["glm-5.3", "claude-opus-5-5", "glm-5.3"]))).toEqual([
      "claude-opus-5-5",
      "glm-5.3",
    ]);
    expect(modelsOf(QUIET)).toEqual([]);
  });

  it("map the registry status onto the daisyUI status dot: working pings, waiting warns, ended stays quiet", () => {
    expect(statusBar("working", true)).toEqual({ word: "Working", dot: "status-success", ping: true });
    expect(statusBar("idle", true)).toEqual({ word: "Waiting for you", dot: "status-warning", ping: false });
    expect(statusBar(null, false)).toEqual({ word: "Ended", dot: "", ping: false });
  });

  it("read a live session whose registry status is still unknown as alive, not ended", () => {
    expect(statusBar(null, true)).toEqual({ word: "Working", dot: "status-success", ping: false });
  });

  it("count live subagents only: the session's own main agent never sits in its badge", () => {
    // a live session's store count includes the main agent itself
    expect(liveSubagents(4, true)).toBe(3);
    expect(liveSubagents(1, true)).toBe(0);
    expect(liveSubagents(0, true)).toBe(0);
    // an ended session has nothing live, whatever a stale count said
    expect(liveSubagents(4, false)).toBe(0);
  });

  it("take the live count from the item's own liveAgentCount, never its total agentCount", () => {
    const item = {
      id: "s1",
      name: "Fleet sweep",
      project: "app",
      repo: null,
      cwd: null,
      branch: null,
      status: "working",
      live: true,
      agentCount: 224,
      liveAgentCount: 4,
      startedAt: null,
      endedAt: null,
      lastAt: NOW,
      costUsd: null,
      activity: QUIET,
    } as const;
    // the item's live count of 4 is main + 3 subagents, so the card badges 3
    expect(cardOfSession(item)).toMatchObject({ liveAgents: 3, agentCount: 224 });
  });

  it("carry the item's now line, context and working directory through to the card", () => {
    const item = {
      id: "s1",
      name: null,
      project: "app",
      repo: "/w/app",
      cwd: "/w/app/pkg",
      branch: null,
      status: "working" as const,
      live: true,
      agentCount: 1,
      liveAgentCount: 1,
      startedAt: null,
      endedAt: null,
      lastAt: 500,
      activity: QUIET,
      now: { what: "↳ prompt: fix the rail", ts: 400 },
      context: { used: 120_000, window: 200_000 },
    };
    const carried = cardOfSession(item);
    expect(carried.cwd).toBe("/w/app/pkg");
    expect(carried.now).toEqual({ what: "↳ prompt: fix the rail", ts: 400 });
    expect(carried.context).toEqual({ used: 120_000, window: 200_000 });
    expect(carried.repo).toBe("/w/app");
    // absent now/context read as null, and an ended item carries no status
    const {
      now: _droppedNow,
      context: _droppedContext,
      ...endedItem
    } = { ...item, live: false, status: null };
    const bare = cardOfSession(endedItem);
    expect(bare.now).toBeNull();
    expect(bare.context).toBeNull();
    expect(bare.status).toBeNull();
  });
});

describe("worktreeName", () => {
  it("names the worktree a `worktrees/` folder carries, however deep", () => {
    expect(worktreeName("/w/app/.agents/worktrees/homelab", "/w/app")).toBe("homelab");
    expect(worktreeName("/w/app/.claude/worktrees/x/sub", "/w/app")).toBe("x");
    expect(worktreeName("/Users/raouf/proxbeam/.agents/worktrees/homelab", "/Users/raouf/proxbeam")).toBe(
      "homelab",
    );
  });

  it("stays null for the repo root and a plain subfolder, and names a checkout outside the repo", () => {
    expect(worktreeName("/w/app", "/w/app")).toBeNull();
    expect(worktreeName("/w/app/src/ui", "/w/app")).toBeNull();
    // a linked worktree elsewhere: the directory's own last segment
    expect(worktreeName("/Users/raouf/Playground/wt-cards", "/Users/raouf/Playground/proxbeam")).toBe(
      "wt-cards",
    );
    expect(worktreeName("/w/app/.agents/worktrees", "/w/app")).toBeNull(); // nothing after the folder
  });

  it("needs both paths to say anything", () => {
    expect(worktreeName(null, "/w/app")).toBeNull();
    expect(worktreeName("/w/app/.agents/worktrees/homelab", null)).toBeNull();
    expect(worktreeName(null, null)).toBeNull();
  });
});

describe("pathParts", () => {
  it("splits a working directory into the repo prefix and the place inside it, both home-shortened", () => {
    expect(pathParts("/Users/raouf/proxbeam/.agents/worktrees/homelab", "/Users/raouf/proxbeam")).toEqual({
      head: "~/proxbeam/",
      tail: ".agents/worktrees/homelab",
    });
    expect(pathParts("/w/app/src/ui", "/w/app")).toEqual({ head: "/w/app/", tail: "src/ui" });
  });

  it("keeps the whole directory when it is outside the repo, or there is no repo", () => {
    expect(pathParts("/elsewhere/wt", "/w/app")).toEqual({ head: "", tail: "/elsewhere/wt" });
    expect(pathParts("/Users/raouf/wt", null)).toEqual({ head: "", tail: "~/wt" });
  });

  it("falls back to the repo path without a working directory, and to nothing with neither", () => {
    expect(pathParts(null, "/Users/raouf/proxbeam")).toEqual({ head: "~/proxbeam", tail: "" });
    expect(pathParts(null, null)).toEqual({ head: "", tail: "" });
  });
});

describe("contextGauge", () => {
  it("reads green under 60%, warning under 85%, error from there", () => {
    expect(contextGauge(590, 1000)).toEqual({ pct: 59, tone: "text-success" });
    expect(contextGauge(600, 1000)).toEqual({ pct: 60, tone: "text-warning" });
    expect(contextGauge(840, 1000)).toEqual({ pct: 84, tone: "text-warning" });
    expect(contextGauge(850, 1000)).toEqual({ pct: 85, tone: "text-error" });
    expect(contextGauge(200_000, 200_000)).toEqual({ pct: 100, tone: "text-error" });
  });

  it("never passes 100 nor divides by a window of nothing", () => {
    expect(contextGauge(400_000, 200_000).pct).toBe(100);
    expect(contextGauge(50, 0)).toEqual({ pct: 0, tone: "text-success" });
  });
});

describe("the card's now line", () => {
  function line(session: CardSession) {
    const { container, unmount } = renderApp(<SessionCard session={session} onSelect={() => {}} />, {}, NOW);
    const text = container.querySelector("button[data-card]")?.textContent ?? "";
    unmount();
    return text;
  }

  it("reads the main agent's newest call while the session works, with when it went out", () => {
    const text = line(card({ now: { what: "↳ prompt: fix the rail", ts: NOW - 4_000 } }));
    expect(text).toContain("prompt: fix the rail");
    expect(text).toContain("4s ago");
    expect(text).not.toContain("Waiting for you");
  });

  it("says 'Waiting for you' with the last word of an idle session, in the warning colour", () => {
    const { container, unmount } = renderApp(
      <SessionCard session={card({ status: "idle", lastAt: NOW - 90_000 })} onSelect={() => {}} />,
      {},
      NOW,
    );
    const body = container.querySelector("button[data-card]")?.textContent ?? "";
    expect(body).toContain("Waiting for you · 1m ago");
    const nowLine = container.querySelector<HTMLElement>("span.text-warning");
    expect(nowLine?.className).toContain("truncate");
    expect(nowLine?.className).toContain("text-sm");
    expect(nowLine?.textContent).toContain("Waiting for you");
    unmount();
  });

  it("says 'Ended' with how long the session ran once it is over, and skips the run without a start", () => {
    const ended = line(
      card({
        live: false,
        status: null,
        startedAt: NOW - 3_600_000,
        endedAt: NOW - 60_000,
        lastAt: NOW - 60_000,
      }),
    );
    expect(ended).toContain("Ended 1m ago · ran 59m00s");
    // no known start, no run length
    const undated = line(card({ live: false, status: null, startedAt: null, endedAt: NOW - 60_000 }));
    expect(undated).toContain("Ended 1m ago");
    expect(undated).not.toContain("ran");
  });

  it("keeps 'Working' with the last word when the working session has no call to quote", () => {
    const text = line(card({ now: null, lastAt: NOW - 30_000 }));
    expect(text).toContain("Working · 30s ago");
  });
});

describe("the card's where block", () => {
  it("badges the branch and the worktree, and shows the full path with the repo prefix dimmer", () => {
    const { container, unmount } = renderApp(
      <SessionCard
        session={card({
          repo: "/Users/raouf/proxbeam",
          cwd: "/Users/raouf/proxbeam/.agents/worktrees/homelab",
          branch: "homelab",
        })}
        onSelect={() => {}}
      />,
    );
    expect(container.querySelector('[title="Branch homelab"]')?.className).toContain("badge-outline");
    expect(
      container.querySelector('[title="Worktree homelab of /Users/raouf/proxbeam"]')?.className,
    ).toContain("badge-outline");
    // the path wraps between folders, the prefix dimmer than the place inside it, no box inside the box
    const path = container.querySelector<HTMLElement>(".break-words");
    expect(path?.className).not.toContain("truncate");
    expect(path?.className).toContain("text-xs");
    const [prefix, place] = [...(path?.children ?? [])] as HTMLElement[];
    expect(prefix?.className).toContain("text-base-content/40");
    expect(prefix?.textContent).toBe("~/proxbeam/");
    expect(place?.className).toContain("text-base-content/80");
    expect(place?.textContent).toBe(".agents/worktrees/homelab");
    // the old inset field is gone: no rounded, tinted box around the rows
    expect(container.querySelector(".bg-base-300\\/40")).toBeNull();
    unmount();
  });

  it("badges nothing when the session runs in the repo root or a plain subfolder", () => {
    const root = renderApp(
      <SessionCard session={card({ repo: "/w/app", cwd: "/w/app", branch: "main" })} onSelect={() => {}} />,
    );
    expect(root.container.querySelector('[title="Branch main"]')).not.toBeNull();
    expect(root.container.querySelector('[title^="Worktree"]')).toBeNull();
    // the repo path alone, in full colour (it is all there is)
    expect(root.container.textContent).toContain("/w/app");
    root.unmount();
    const sub = renderApp(
      <SessionCard session={card({ repo: "/w/app", cwd: "/w/app/src/ui" })} onSelect={() => {}} />,
    );
    expect(sub.container.querySelector('[title^="Worktree"]')).toBeNull();
    sub.unmount();
  });

  it("omits the where block entirely when neither the directory nor the repo is known", () => {
    const { container, unmount } = renderApp(<SessionCard session={card()} onSelect={() => {}} />);
    expect(container.querySelector(".break-words")).toBeNull();
    unmount();
  });
});

describe("the card's gauge and weight row", () => {
  it("gauges the main context as a daisyUI radial-progress at the card's size, coloured by how full it is", () => {
    const { container, unmount } = renderApp(
      <SessionCard session={card({ context: { used: 124_000, window: 200_000 } })} onSelect={() => {}} />,
    );
    const gauge = container.querySelector<HTMLElement>("[role='progressbar']");
    expect(gauge?.className).toContain("radial-progress");
    expect(gauge?.className).toContain("text-warning"); // 62%
    expect(gauge?.className).toContain("text-xs");
    expect(gauge?.getAttribute("aria-valuenow")).toBe("62");
    const style = gauge?.getAttribute("style")?.replace(/\s/g, "") ?? "";
    expect(style).toContain("--value:62");
    expect(style).toContain("--size:2.25rem");
    expect(style).toContain("--thickness:3px");
    expect(gauge?.textContent).toBe("62");
    expect(gauge?.getAttribute("aria-label")).toBe("Main context 124k of 200k tokens");
    expect(container.querySelector(".tooltip")?.getAttribute("data-tip")).toBe(
      "Main context 124k of 200k tokens",
    );
    unmount();
    const danger = renderApp(
      <SessionCard session={card({ context: { used: 950_000, window: 1_000_000 } })} onSelect={() => {}} />,
    );
    expect(danger.container.querySelector("[role='progressbar']")?.className).toContain("text-error");
    danger.unmount();
  });

  it("badge the running subagents apart from the total: 'N running' only when N > 0, the count beside it", () => {
    const busy = renderApp(
      <SessionCard session={card({ liveAgents: 4, agentCount: 224 })} onSelect={() => {}} />,
    );
    const badge = busy.container.querySelector("button[data-card]")?.textContent ?? "";
    expect(badge).toContain("4 running");
    expect(badge).not.toContain("4 live");
    expect(badge).toContain("224 agents");
    busy.unmount();
    const quiet = renderApp(
      <SessionCard session={card({ liveAgents: 0, agentCount: 224 })} onSelect={() => {}} />,
    );
    const quietText = quiet.container.querySelector("button[data-card]")?.textContent ?? "";
    expect(quietText).not.toContain("running");
    expect(quietText).toContain("224 agents");
    quiet.unmount();
  });

  it("say '1 agent' in the singular, as everywhere counts are read", () => {
    const single = renderApp(
      <SessionCard session={card({ liveAgents: 0, agentCount: 1 })} onSelect={() => {}} />,
    );
    expect(single.container.querySelector("button[data-card]")?.textContent).toContain("1 agent");
    expect(single.container.querySelector("button[data-card]")?.textContent).not.toContain("1 agents");
    single.unmount();
  });
});

describe("the card itself", () => {
  it("is one daisyUI card button: p-4 rows on the lighter base, pointer cursor, hover lighting it", () => {
    const working = renderApp(<SessionCard session={card({ status: "working" })} onSelect={() => {}} />);
    const button = working.container.querySelector("button[data-card]") as HTMLElement;
    for (const wanted of [
      "card",
      "cursor-pointer",
      "rounded-box",
      "bg-base-100/60",
      "p-4",
      "hover:bg-base-100",
    ]) {
      expect(button.className).toContain(wanted);
    }
    expect(button.className).not.toContain("card-sm"); // the old, small card is gone
    expect(button.querySelector("span.card-body")).toBeNull(); // the rows sit on the card itself
    // the state travels with the card for anyone who cannot see the colour
    expect(button.getAttribute("aria-label")).toBe("Fleet sweep, working");
    working.unmount();
  });

  it("carry the state as a large status dot in the title row, pinging while working", () => {
    const working = renderApp(<SessionCard session={card({ status: "working" })} onSelect={() => {}} />);
    const pinging = working.container.querySelectorAll("span.status");
    expect(pinging.length).toBe(2); // the dot and its pinging twin behind it
    for (const dot of pinging) {
      expect(dot.className).toContain("status-success");
      expect(dot.className).toContain("status-lg");
    }
    expect(pinging[1]?.className).toContain("neon-dot"); // the live dot glows
    expect(working.container.querySelector('[title="Working"]')).not.toBeNull();
    working.unmount();
    const waiting = renderApp(<SessionCard session={card({ status: "idle" })} onSelect={() => {}} />);
    const idleDots = waiting.container.querySelectorAll("span.status");
    expect(idleDots).toHaveLength(1);
    expect(idleDots[0]?.className).toContain("status-warning");
    waiting.unmount();
    // a live card with no registry status yet still reads alive: the steady success dot, never "Ended"
    const unknown = renderApp(<SessionCard session={card({ status: null })} onSelect={() => {}} />);
    const liveDots = unknown.container.querySelectorAll("span.status");
    expect(liveDots).toHaveLength(1);
    expect(liveDots[0]?.className).toContain("status-success");
    expect(unknown.container.querySelector("button[data-card]")?.getAttribute("aria-label")).toBe(
      "Fleet sweep, working",
    );
    unknown.unmount();
    const over = renderApp(<SessionCard session={card({ status: null, live: false })} onSelect={() => {}} />);
    const endedDots = over.container.querySelectorAll("span.status");
    expect(endedDots).toHaveLength(1);
    expect(endedDots[0]?.className).toContain("status-lg");
    expect(endedDots[0]?.className).not.toContain("status-success");
    expect(over.container.querySelector("button[data-card]")?.getAttribute("aria-label")).toBe(
      "Fleet sweep, ended",
    );
    over.unmount();
  });

  it("keep the cost on the title row at the card's text size, and the arrow keys working", () => {
    const { container } = renderApp(<SessionCard session={card({ costUsd: 1.25 })} onSelect={() => {}} />);
    const cost = container.querySelector("button[data-card]")?.textContent ?? "";
    expect(cost).toContain("$1.25");
    const keys = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    container.querySelector<HTMLElement>("[data-card-list]")?.setAttribute("data-card-list", "");
    container.querySelector<HTMLElement>("button[data-card]")?.dispatchEvent(keys);
    expect(keys.defaultPrevented).toBe(true);
  });

  it("wrap a picked card in the aura — exactly one child — with the Viewing check beside the cost", () => {
    const picked = renderApp(<SessionCard session={card({ costUsd: 1.25 })} selected onSelect={() => {}} />);
    const wrapper = picked.container.querySelector("button[data-card]")?.parentElement;
    expect(wrapper?.className).toContain("aura");
    expect(wrapper?.className).toContain("aura-sm");
    expect(wrapper?.className).toContain("block");
    expect(wrapper?.childElementCount).toBe(1);
    const button = picked.container.querySelector("button[data-card]");
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    const viewing = button?.querySelector('.badge[title="This session is in the view"]');
    expect(viewing?.textContent).toContain("Viewing");
    expect(viewing?.className).toContain("badge-outline");
    picked.unmount();
    const bare = renderApp(<SessionCard session={card()} onSelect={() => {}} />);
    expect(bare.container.querySelector("button[data-card]")?.parentElement?.className).not.toContain("aura");
    expect(bare.container.querySelector("button[data-card]")?.getAttribute("aria-pressed")).toBe("false");
    expect(bare.container.textContent).not.toContain("Viewing");
    bare.unmount();
  });
});

describe("nowAction", () => {
  it("keeps the action and drops the input that led to it, at whatOf's two-space separator", async () => {
    const { nowAction } = await import("../../src/ui/app/SessionCard.tsx");
    expect(nowAction("↳ 1 tool result  → Bash cd /x")).toBe("Bash cd /x");
    expect(nowAction("prompt: fix it  → Edit a.ts")).toBe("Edit a.ts");
    expect(nowAction("↳ 2 tool results")).toBe("2 tool results");
    expect(nowAction("text")).toBe("text");
  });

  it("keeps an arrow inside the prompt or a tool argument instead of truncating at it", async () => {
    const { nowAction } = await import("../../src/ui/app/SessionCard.tsx");
    expect(nowAction("↳ 1 tool result  → Grep a → b")).toBe("Grep a → b");
    expect(nowAction("↳ prompt: x → y")).toBe("prompt: x → y");
  });
});
