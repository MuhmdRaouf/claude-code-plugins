import { fireEvent, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { FetchFn } from "../src/api.ts";
import { HuddleContext } from "../src/app/context.tsx";
import type { Digest } from "../src/pages/Today.tsx";
import { Today } from "../src/pages/Today.tsx";
import { readPref, type Storage, writePref } from "../src/storage.ts";
import type { PlanStep } from "../src/store.ts";
import { renderHuddle } from "./render.tsx";

const OP = "/api/c/dev/op/digest?as=owner";

const DIG: Digest = {
  since: "2026-10-07T12:00:00Z",
  totals: { done: 2, notes: 1, knowledge: 1, events: 12, blocked: 1, questions: 2 },
  sessions: [
    {
      name: "owner",
      state: null,
      role: "the owner",
      done: [
        { id: "t1", title: "Ship it", status: "done", note: "all green" },
        { id: "t2", title: "Skip me", status: "skipped" },
      ],
      notes: [{ task: "t1", title: "Ship it", kind: "review", body: "looks good" }],
      knowledge: [{ id: 7, kind: "fact", title: "Grafana quirks" }],
      approvals: [
        { seq: 3, labels: ["deploy", "deploy"] },
        { seq: 4, labels: ["deploy"] },
      ],
      asked: 1,
      events: 9,
      cost: 3.5,
    },
    {
      name: "aliceworker",
      state: "left",
      role: null,
      done: [],
      notes: [],
      knowledge: [],
      approvals: [],
      asked: 0,
      events: 0,
      cost: null,
    },
  ],
  blocked: [{ id: "t9", title: "Stuck task", owner: "owner", note: "needs creds", waits_on: ["t1", "t2"] }],
  questions: [
    { seq: 5, from: "aliceworker", to: "owner", msg: "Which port?", at: "2026-10-08T11:00:00Z" },
    { seq: 6, from: "bobworker", to: null, msg: "Anyone there?", at: "2026-10-08T10:00:00Z" },
  ],
  cost: { available: true, total: 12.5, range: "day" },
};

/** A storage the tests read back (the browser's site data, injected). */
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
}

/** A JSON response with the usual content type. */
function jsonResponse(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
}

/** A pending response the test hands out later. */
function deferred(): { promise: Promise<Response>; give: (r: Response) => void } {
  let give: (r: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    give = resolve;
  });
  return { promise, give };
}

/** A fetch that answers the digest op: the JSON digest when asked, its text otherwise. */
function digestFetch(dig: Digest | null, fail = false, textFail = false): Mock<FetchFn> {
  const answer = (url: string, body: Record<string, unknown>): Response => {
    if (url !== OP) return jsonResponse({});
    if (fail) return jsonResponse({ error: "boom" }, 500);
    if (body.json) return jsonResponse({ result: dig });
    if (textFail) return jsonResponse({ error: "late" }, 500);
    return jsonResponse({ result: dig, text: "DIGEST TEXT" });
  };
  return vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    return answer(url, body);
  });
}

/** The stale-digest flow: the first json answer is held until the test releases it. */
function digestStaleFetch(): Mock<FetchFn> & { release: (r: Response) => void } {
  const first = deferred();
  let n = 0;
  const answer = (url: string, body: Record<string, unknown>): Response | Promise<Response> => {
    if (url !== OP) return jsonResponse({});
    if (!body.json) return jsonResponse({ result: DIG, text: "DIGEST TEXT" });
    n += 1;
    if (n === 1) return first.promise;
    return jsonResponse({ result: DIG });
  };
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    return answer(url, body);
  }) as Mock<FetchFn> & { release: (r: Response) => void };
  fetchFn.release = first.give;
  return fetchFn;
}

let prefs: Storage;

beforeEach(() => {
  prefs = memStorage();
});

const ROSTER = { sessions: [{ name: "owner", state: "working" as const }] };

describe("Today", () => {
  it("renders the stat cards of a fake digest, cost included", async () => {
    const { container } = renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, digestFetch(DIG));
    await screen.findByText("By session");
    expect(container.querySelector(".stat-value")?.textContent).toBe("2");
    expect(screen.getByText("Tasks finished").closest(".stat")?.textContent).toContain("12 events since");
    expect(screen.getByText("Knowledge added").closest(".stat")?.textContent).toContain("1 note on tasks");
    expect(screen.getAllByText("Blocked now")[0]?.closest(".stat")?.textContent).toContain("Need a hand");
    expect(screen.getAllByText("Open questions")[0]?.closest(".stat")?.textContent).toContain(
      "Waiting for an answer",
    );
    expect(screen.getByText("Estimated cost").closest(".stat")?.textContent).toContain("$12.50");
    expect(screen.getByText("Estimated cost").closest(".stat")?.textContent).toContain(
      "This day, from Radar",
    );
  });

  it("leaves the cost stat out when Radar does not run", async () => {
    const dig = { ...DIG, cost: { available: false, total: null, range: "day" } };
    renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, digestFetch(dig));
    await screen.findByText("Tasks finished");
    expect(screen.queryByText("Estimated cost")).toBeNull();
  });

  it("shows one card per session with its finished work, shares, notes and approvals", async () => {
    const { container } = renderHuddle(
      <Today prefs={prefs} />,
      { ch: "dev", sessions: ROSTER },
      1,
      digestFetch(DIG),
    );
    await screen.findByText("By session");
    const you = container.querySelector("section[aria-label='You']");
    expect(you?.textContent).toContain("the owner · 9 events");
    expect(you?.textContent).toContain("· 1 open question");
    expect(you?.textContent).toContain("all green");
    expect(you?.textContent).toContain("2× · deploy");
    expect(you?.textContent).toContain("review on");
    expect(you?.textContent).toContain("Grafana quirks");
    // the live roster turns into a small pill on the card's head
    expect(you?.querySelector(".badge.badge-info")?.textContent).toBe("Working");
    // the worker that left still gets a card, headed by its name
    const gone = container.querySelector("section[aria-label='aliceworker']");
    expect(gone?.textContent).toContain("left the channel");
    expect(gone?.textContent).toContain("Nothing finished or shared in this window.");
    expect(container.querySelectorAll(".text-success svg").length).toBeGreaterThanOrEqual(1);
  });

  it("links each session card by name and shows the cost chip", async () => {
    renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, digestFetch(DIG));
    await screen.findByText("By session");
    const name = screen.getAllByText("aliceworker").find((e) => e.tagName === "A");
    expect(name?.getAttribute("href")).toBe("#/c/dev/team?s=aliceworker");
    expect(screen.getByText("$3.50").getAttribute("title")).toBe("Estimated cost, from Radar");
    expect(screen.getByText("Grafana quirks").getAttribute("href")).toBe("#/c/dev/knowledge/7");
  });

  it("renders the blocked card with owners, notes and waits", async () => {
    const { container } = renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, digestFetch(DIG));
    await screen.findByText("Stuck task");
    expect(screen.getByText("Stuck task").closest("a")?.getAttribute("href")).toBe("#/c/dev/work?t=t9");
    expect(container.querySelector("section[aria-label='Blocked now']")?.textContent).toContain(
      "You · “needs creds” · waits on t1, t2",
    );
    expect(container.querySelector("section[aria-label='Blocked now']")?.textContent).toContain("1");
  });

  it("renders the open questions and an Answer in Inbox shortcut", async () => {
    const { container } = renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, digestFetch(DIG));
    await screen.findByText("Which port?");
    const card = container.querySelector("section[aria-label='Open questions']");
    expect(card?.textContent).toContain("aliceworker");
    expect(card?.textContent).toContain("→ You ·");
    expect(card?.textContent).toContain("→ everyone ·");
    expect(card?.querySelector("time")).not.toBeNull();
    expect(screen.getByText("Answer in Inbox").getAttribute("href")).toBe("#/c/dev/inbox");
  });

  it("answers the empty branches: no sessions, nothing blocked, no questions", async () => {
    const dig: Digest = {
      ...DIG,
      sessions: [],
      blocked: [],
      questions: [],
      cost: { available: false, total: null, range: "day" },
    };
    renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, digestFetch(dig));
    await screen.findByText("No activity in this window");
    expect(screen.getByText("Sessions show up here once they join and work.")).not.toBeNull();
    expect(screen.getByText("Nothing is blocked")).not.toBeNull();
    expect(screen.getByText("No open questions")).not.toBeNull();
    expect(screen.queryByText("Answer in Inbox")).toBeNull();
  });

  it("says there is nothing to show when the digest comes back empty", async () => {
    renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, digestFetch(null));
    await screen.findByText("Nothing to show");
  });

  it("copies the digest as text through the clipboard", async () => {
    const { copy } = renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, digestFetch(DIG));
    await screen.findByText("By session");
    fireEvent.click(screen.getByText("Copy as text"));
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith("DIGEST TEXT", "Copied the digest"));
  });

  it("shows the error box when the digest did not load", async () => {
    renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, digestFetch(DIG, true));
    await screen.findByText("The digest did not load");
    expect(screen.getByText("boom")).not.toBeNull();
  });

  it("shows the loading skeleton while the digest is on its way", () => {
    renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, () => new Promise<Response>(() => {}));
    expect(screen.getByLabelText("Loading")).not.toBeNull();
  });

  it("switches the window, remembers it per channel and refetches with it", async () => {
    const fetchFn = digestFetch(DIG);
    renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await screen.findByText("By session");
    const three = screen.getByText("3 days");
    expect(three.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("24 hours").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(three);
    await vi.waitFor(() => {
      expect(fetchFn.mock.calls.some(([u, i]) => u === OP && String(i?.body).includes('"since":"3d"'))).toBe(
        true,
      );
    });
    expect(three.getAttribute("aria-pressed")).toBe("true");
    expect(readPref(prefs, "dgwin:dev", "24h")).toBe("3d");
  });

  it("starts the next channel from the window this browser kept for it", async () => {
    writePref(prefs, "dgwin:dev", "3d");
    const fetchFn = digestFetch(DIG);
    const first = renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await screen.findByText("By session");
    expect(screen.getByText("3 days").getAttribute("aria-pressed")).toBe("true");
    // the address moves to a channel whose own key kept nothing: its default applies, not dev's
    const next = { ...first.value, state: { ...first.value.state, ch: "lab" } };
    first.rerender(
      <HuddleContext.Provider value={next}>
        <Today prefs={prefs} />
      </HuddleContext.Provider>,
    );
    await vi.waitFor(() => {
      const since = fetchFn.mock.calls.at(-1)?.[1]?.body;
      expect(String(since)).toContain('"since":"24h"');
    });
    expect(screen.getByText("24 hours").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("3 days").getAttribute("aria-pressed")).toBe("false");
    expect(readPref(prefs, "dgwin:lab", "24h")).toBe("24h");
  });

  it("adds an and-N-more line when a session wrote more than six notes", async () => {
    const base = DIG.sessions[0];
    const notes = Array.from({ length: 7 }, (_v, i) => ({
      task: `t${i + 10}`,
      title: `T${i}`,
      kind: "review",
      body: `b${i}`,
    }));
    const dig: Digest = { ...DIG, sessions: base ? [{ ...base, notes }] : [] };
    renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, digestFetch(dig));
    await screen.findByText("and 1 more");
  });

  it("colours a card's pill from the session's current task, known or not", async () => {
    const byId = new Map<string, PlanStep>([["t9", { id: "t9", status: "blocked" }]]);
    const roster = {
      sessions: [
        { name: "owner", state: "working" as const, step: "t9" },
        { name: "aliceworker", state: "working" as const, step: "nope" },
      ],
    };
    const { container } = renderHuddle(
      <Today prefs={prefs} />,
      { ch: "dev", sessions: roster, board: { steps: [] }, byId },
      1,
      digestFetch(DIG),
    );
    await screen.findByText("By session");
    expect(container.querySelector("section[aria-label='You'] .badge.badge-error")?.textContent).toBe(
      "Blocked",
    );
    expect(container.querySelector("section[aria-label='aliceworker'] .badge.badge-info")?.textContent).toBe(
      "Working",
    );
  });

  it("fills a card that only finished something, its other sections empty", async () => {
    const base = DIG.sessions[0];
    const dig: Digest = {
      ...DIG,
      sessions: base ? [{ ...base, notes: [], knowledge: [], approvals: [], asked: 0 }] : [],
    };
    renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, digestFetch(dig));
    await screen.findByText("Ship it");
    expect(screen.queryByText("Nothing finished or shared in this window.")).toBeNull();
    expect(screen.queryByText("Knowledge shared")).toBeNull();
  });

  it("drops a stale digest answer once the window has changed", async () => {
    const fetchFn = digestStaleFetch();
    renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    fireEvent.click(screen.getByText("3 days"));
    await screen.findByText("By session");
    fetchFn.release(jsonResponse({ result: DIG }));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getByText("By session")).not.toBeNull();
    expect(screen.queryByText("The digest did not load")).toBeNull();
  });

  it("drops a stale failing digest answer the same way", async () => {
    const fetchFn = digestStaleFetch();
    renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    fireEvent.click(screen.getByText("3 days"));
    await screen.findByText("By session");
    fetchFn.release(jsonResponse({ error: "late" }, 500));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText("The digest did not load")).toBeNull();
  });

  it("lets a failing text refetch pass without a copy", async () => {
    const { copy } = renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, digestFetch(DIG, false, true));
    await screen.findByText("By session");
    fireEvent.click(screen.getByText("Copy as text"));
    await new Promise((r) => setTimeout(r, 10));
    expect(copy).not.toHaveBeenCalled();
  });

  it("falls back on every missing field: board titles, bare ids, empty owners, plurals", async () => {
    const byId = new Map<string, PlanStep>([
      ["t1", { id: "t1", title: "From the board" }],
      ["tx", { id: "tx" }],
    ]);
    const dig: Digest = {
      ...DIG,
      totals: { ...DIG.totals, notes: 2, blocked: 0, questions: 0 },
      sessions: [
        {
          name: "carolworker",
          state: null,
          role: null,
          done: [
            { id: "t1", title: null, status: "done" },
            { id: "t99", title: null, status: "skipped" },
          ],
          notes: [{ task: null, title: null, kind: null, body: "a bare note" }],
          knowledge: [{ id: 9, kind: null, title: null }],
          approvals: [{ seq: 1 }],
          asked: 2,
          events: 1,
          cost: null,
        },
      ],
      blocked: [{ id: "t1", title: null, owner: null, note: "", waits_on: [] }],
      questions: [],
      cost: { available: true, total: null, range: "week" },
    };
    const { container } = renderHuddle(
      <Today prefs={prefs} />,
      { ch: "dev", board: { steps: [] }, byId },
      1,
      digestFetch(dig),
    );
    await screen.findByText("a bare note");
    expect(screen.getAllByText("From the board").length).toBe(2);
    const card = container.querySelector("section[aria-label='carolworker']");
    expect(card?.textContent).toContain("1 event");
    expect(card?.textContent).toContain("· 2 open questions");
    expect(card?.textContent).toContain("a bare note");
    expect(card?.textContent).toContain("#9");
    expect(card?.textContent).toContain("1×");
    expect(screen.getAllByText("2 notes on tasks").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Nothing stuck").length).toBeGreaterThan(0);
    expect(screen.getAllByText("All answered").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$0").length).toBeGreaterThan(0);
    expect(container.querySelector("section[aria-label='Blocked now']")?.textContent).toContain(
      "Nobody owns it",
    );
    expect(container.querySelector("a[href='#/c/dev/work?t=t1']")?.textContent).toContain("From the board");
  });

  it("reads a session's error as text when it is not an Error, and skips an empty copy", async () => {
    const fetchFn = vi.fn(async (url: string): Promise<Response> => {
      if (url === OP) throw "string failure";
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    const bad = renderHuddle(<Today prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await bad.findByText("The digest did not load");
    expect(bad.getByText("string failure")).not.toBeNull();
    bad.unmount();
    const ok = renderHuddle(
      <Today prefs={prefs} />,
      { ch: "dev" },
      1,
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        const json = (v: unknown): Response =>
          new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
        if (url === OP && body.json) return json({ result: DIG });
        return json({ result: DIG, text: null });
      }),
    );
    await ok.findByText("By session");
    fireEvent.click(ok.getByText("Copy as text"));
    await new Promise((r) => setTimeout(r, 10));
    expect(ok.copy).not.toHaveBeenCalled();
  });

  it("renders nothing without an open channel", () => {
    const { container } = renderHuddle(<Today prefs={prefs} />, {}, 1, digestFetch(DIG));
    expect(container.querySelector("#dgwrap")).toBeNull();
  });
});
