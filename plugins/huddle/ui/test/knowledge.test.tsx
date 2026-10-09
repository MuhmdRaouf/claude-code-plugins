import { act, fireEvent, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { FetchFn } from "../src/api.ts";
import { HuddleContext } from "../src/app/context.tsx";
import {
  ExportActions,
  Hits,
  KB_KINDS,
  KB_L,
  type KbEntry,
  KbTag,
  Knowledge,
  kbAge,
  kbMarks,
} from "../src/pages/Knowledge.tsx";
import { readPref, type Storage } from "../src/storage.ts";
import type { HuddleStore } from "../src/store.ts";
import { renderHuddle } from "./render.tsx";

const KB = "/api/c/dev/kb?q=&kind=&limit=50";
const SHARE = "/api/c/dev/op/share?as=owner";
const VERIFY = "/api/c/dev/op/verify?as=owner";

const ROWS: KbEntry[] = [
  {
    id: 2,
    kind: "lesson",
    title: "Second entry",
    body: "b2",
    by: "aliceworker",
    created_at: "2026-09-18T10:00:00Z",
    age_days: 1,
    hit: "the «port» to use",
  },
  {
    id: 1,
    kind: "fact",
    title: "First entry",
    body: "b1",
    by: "owner",
    created_at: "2026-09-15T10:00:00Z",
    age_days: 3,
    hit: "plain hit",
  },
];

const ENTRY: KbEntry = {
  id: 2,
  kind: "lesson",
  title: "Second entry",
  body: "# Body\ntext",
  by: "aliceworker",
  created_at: "2026-09-18T10:00:00Z",
  hits: 2,
  task: "t1",
  scope: "channel",
  tags: ["grafana", "ports"],
  refs: ["see `x`"],
  age_days: 1,
};

/** A storage the tests read back (the browser's site data, injected). */
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
}

/** What the fake kb server answers for one url. */
function kbResponse(
  url: string,
  o: { rows: KbEntry[]; entry: KbEntry | null; fail: string[]; md: string; mdVerified: string },
): Response {
  const json = (v: unknown, status = 200): Response =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (o.fail.includes(url)) return json({ error: "boom" }, 500);
  if (/\/kb\?/.test(url)) return json(o.rows);
  if (/\/kb\/\d+$/.test(url))
    return json(o.entry !== null && url.endsWith(`/${o.entry.id}`) ? o.entry : null);
  if (url === "/api/c/dev/knowledge.md") return json(o.md);
  if (url === "/api/c/dev/knowledge.md?verified=1") return json(o.mdVerified);
  if (url === SHARE) return json({ result: { id: 9 } });
  return json({});
}

/** A fetch answering the kb routes; entries may be swapped and paths named to answer 500. */
function kbFetch(o: {
  rows?: KbEntry[];
  entry?: KbEntry | null;
  fail?: string[];
  md?: string;
  mdVerified?: string;
}): Mock<FetchFn> {
  const full = {
    rows: ROWS,
    entry: ENTRY,
    fail: [] as string[],
    md: "# Knowledge\n- a",
    mdVerified: "# Verified",
    ...o,
  };
  return vi.fn(async (url: string) => kbResponse(url, full));
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

/** The stale-answer flow: a held first list and a held /kb/2, everything else instant. */
function staleKbFetch(): {
  fetchFn: Mock<FetchFn>;
  firstList: { give: (r: Response) => void };
  heldEntry: { give: (r: Response) => void };
} {
  const firstList = deferred();
  const heldEntry = deferred();
  let lists = 0;
  const answer = (url: string): Response | Promise<Response> => {
    if (/\/kb\?/.test(url)) {
      lists += 1;
      if (lists === 1) return firstList.promise;
      if (lists === 2) return jsonResponse(ROWS);
      return jsonResponse([ROWS[1]]);
    }
    if (/\/kb\/2$/.test(url)) return heldEntry.promise;
    return jsonResponse(ENTRY);
  };
  return { fetchFn: vi.fn(async (url: string) => answer(url)), firstList, heldEntry };
}

let prefs: Storage;

beforeEach(() => {
  prefs = memStorage();
});

/** The list is in; the reader's markdown heading is the reader's arrival. */
const listLoaded = (): Promise<HTMLElement> => screen.findByText("First entry");
const readerLoaded = (): Promise<HTMLElement> => screen.findByText("Body");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Knowledge list", () => {
  it("renders the rows with their kind chip, hit highlight and age, newest marked current", async () => {
    const { container } = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, kbFetch({}));
    await listLoaded();
    await readerLoaded();
    const link = screen.getAllByText("Second entry").find((e) => e.closest("a"));
    expect(link?.closest("a")?.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("First entry").closest("a")?.getAttribute("aria-current")).toBeNull();
    expect(screen.getAllByText("Lesson").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Fact").length).toBeGreaterThan(0);
    expect(container.querySelector("mark")?.textContent).toBe("port");
    expect(container.querySelector("#kblist")?.textContent).toContain("· 1 day old");
    expect(container.querySelector("#kblist")?.textContent).toContain("· 3 days old");
    expect(container.querySelector("#kblist time")).not.toBeNull();
  });

  it("searches and remembers the query per channel", async () => {
    const fetchFn = kbFetch({});
    renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await listLoaded();
    fireEvent.input(screen.getByLabelText("Search knowledge"), { target: { value: "ports " } });
    await vi.waitFor(() => {
      expect(fetchFn.mock.calls.some(([u]) => u === "/api/c/dev/kb?q=ports&kind=&limit=50")).toBe(true);
    });
    expect(readPref(prefs, "kbq:dev", "")).toBe("ports");
  });

  it("filters by kind, remembers it per channel and offers every kind", async () => {
    const fetchFn = kbFetch({});
    renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await listLoaded();
    expect(screen.getByText("All").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("How-to"));
    await vi.waitFor(() => {
      expect(fetchFn.mock.calls.some(([u]) => u === "/api/c/dev/kb?q=&kind=howto&limit=50")).toBe(true);
    });
    expect(screen.getByText("How-to").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("All").getAttribute("aria-pressed")).toBe("false");
    expect(readPref(prefs, "kbk:dev", "")).toBe("howto");
    for (const k of KB_KINDS) expect(screen.getAllByText(KB_L[k]).length).toBeGreaterThan(0);
  });

  it("says no entry matches when the list comes back empty", async () => {
    renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, kbFetch({ rows: [] }));
    await screen.findByText("No entry matches");
    expect(screen.getByText("Try other words or another kind.")).not.toBeNull();
  });

  it("reads the list and the open entry again when the store says knowledge changed", async () => {
    const subs = new Set<(what: string) => void>();
    const store = {
      subscribe: vi.fn((f: (what: string) => void) => {
        subs.add(f);
        return () => subs.delete(f);
      }),
    } as unknown as HuddleStore;
    const fetchFn = kbFetch({});
    renderHuddle(<Knowledge prefs={prefs} store={store} />, { ch: "dev" }, 1, fetchFn);
    await readerLoaded();
    expect(fetchFn.mock.calls.filter(([u]) => u === KB)).toHaveLength(1);
    expect(fetchFn.mock.calls.filter(([u]) => u === "/api/c/dev/kb/2")).toHaveLength(1);
    for (const f of subs) f("kb");
    await vi.waitFor(() => {
      expect(fetchFn.mock.calls.filter(([u]) => u === KB)).toHaveLength(2);
      expect(fetchFn.mock.calls.filter(([u]) => u === "/api/c/dev/kb/2")).toHaveLength(2);
    });
    // another kind of change stays quiet
    for (const f of subs) f("tl");
    expect(fetchFn.mock.calls.filter(([u]) => u === KB)).toHaveLength(2);
  });

  it("reads the search and kind the new channel kept when the channel changes", async () => {
    const h = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, kbFetch({}));
    await listLoaded();
    fireEvent.input(screen.getByLabelText("Search knowledge"), { target: { value: "ports " } });
    await vi.waitFor(() => expect(readPref(prefs, "kbq:dev", "")).toBe("ports"));
    fireEvent.click(screen.getByText("How-to"));
    await vi.waitFor(() => expect(readPref(prefs, "kbk:dev", "")).toBe("howto"));
    // the other channel's kept filters (none) take over, the way Team's filters do
    h.rerender(
      <HuddleContext.Provider value={{ ...h.value, state: { ...h.value.state, ch: "lab" } }}>
        <Knowledge prefs={prefs} />
      </HuddleContext.Provider>,
    );
    expect((screen.getByLabelText("Search knowledge") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("All").getAttribute("aria-pressed")).toBe("true");
  });

  it("falls back to an empty list when the list fails", async () => {
    renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, kbFetch({ fail: [KB] }));
    await screen.findByText("No entry matches");
  });
});

describe("Knowledge reader", () => {
  it("opens the newest entry by default with its history, tags, references and body", async () => {
    const { container } = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, kbFetch({}));
    await readerLoaded();
    const card = container.querySelector("#kbr article");
    expect(card?.textContent).toContain("By aliceworker ·");
    expect(card?.textContent).toContain("· read 2 times");
    expect(card?.textContent).toContain("· task");
    expect(screen.getByText("t1").getAttribute("href")).toBe("#/c/dev/work?t=t1");
    expect(screen.getByText("grafana")).not.toBeNull();
    expect(card?.textContent).toContain("References");
    expect(card?.querySelector("code")?.textContent).toBe("x");
    expect(screen.getByText("Body").tagName).toBe("H2");
  });

  it("shows who verified an entry and its mark", async () => {
    const { container } = renderHuddle(
      <Knowledge prefs={prefs} />,
      { ch: "dev" },
      1,
      kbFetch({ entry: { ...ENTRY, verified_at: "2026-09-18T11:00:00Z", verified_by: "owner" } }),
    );
    await readerLoaded();
    expect(container.querySelector("#kbr article")?.textContent).toContain("Verified by owner");
    expect(container.querySelector(".badge-success")?.getAttribute("title")).toBe("Verified by owner");
  });

  it("says an old unverified entry may be out of date, and never when it was just written", async () => {
    const { container } = renderHuddle(
      <Knowledge prefs={prefs} />,
      { ch: "dev" },
      1,
      kbFetch({ entry: { ...ENTRY, age_days: 3 } }),
    );
    await readerLoaded();
    expect(container.querySelector("#kbr article")?.textContent).toContain("3 days old, not verified yet.");
    container.remove();
    const fresh = renderHuddle(
      <Knowledge prefs={prefs} />,
      { ch: "dev" },
      1,
      kbFetch({ entry: { ...ENTRY, age_days: 0 } }),
    );
    await fresh.findByText("Body");
    expect(fresh.container.querySelector("#kbr article")?.textContent).toContain("Not verified yet.");
  });

  it("warns about a stale entry and offers Verify beside Share", async () => {
    const { container } = renderHuddle(
      <Knowledge prefs={prefs} />,
      { ch: "dev" },
      1,
      kbFetch({ entry: { ...ENTRY, stale: "not verified for over 30 days" } }),
    );
    await readerLoaded();
    const card = container.querySelector("#kbr article");
    expect(card?.textContent).toContain(
      "May be stale: not verified for over 30 days. Check it, then verify it or replace it.",
    );
    expect(container.querySelector(".badge-warning")?.getAttribute("title")).toBe(
      "not verified for over 30 days",
    );
    expect(screen.getByText("Verify").closest("button")?.getAttribute("data-kbv")).toBe("do");
    expect(screen.getByText("Share with every channel")).not.toBeNull();
  });

  it("calls the verify op, toasts and reads the entry again where it sits", async () => {
    const fetchFn = kbFetch({});
    const h = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await readerLoaded();
    fireEvent.click(screen.getByText("Verify"));
    await vi.waitFor(() => {
      expect(String(fetchFn.mock.calls.find(([u]) => u === VERIFY)?.[1]?.body)).toContain('"undo":false');
      expect(h.toast).toHaveBeenCalledWith("Verified");
      // the entry is refetched, not re-navigated to
      expect(fetchFn.mock.calls.filter(([u]) => u === "/api/c/dev/kb/2")).toHaveLength(2);
      expect(h.go).not.toHaveBeenCalled();
    });
  });

  it("offers Unverify for a verified, fresh entry and calls verify with undo", async () => {
    const fetchFn = kbFetch({
      entry: { ...ENTRY, verified_at: "2026-09-18T11:00:00Z", verified_by: "owner" },
    });
    const h = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await screen.findByText("Unverify");
    fireEvent.click(screen.getByText("Unverify"));
    await vi.waitFor(() => {
      expect(String(fetchFn.mock.calls.find(([u]) => u === VERIFY)?.[1]?.body)).toContain('"undo":true');
      expect(h.toast).toHaveBeenCalledWith("No longer verified");
    });
  });

  it("toasts a failing verify and gives the button back", async () => {
    const h = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, kbFetch({ fail: [VERIFY] }));
    await screen.findByText("Verify");
    fireEvent.click(screen.getByText("Verify"));
    await vi.waitFor(() => {
      expect(h.toast).toHaveBeenCalledWith("boom", { bad: true });
    });
    expect((screen.getByText("Verify") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shares with every channel and reopens under the new id", async () => {
    const fetchFn = kbFetch({});
    const h = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await readerLoaded();
    fireEvent.click(screen.getByText("Share with every channel"));
    await vi.waitFor(() => {
      expect(fetchFn.mock.calls.some(([u]) => u === SHARE)).toBe(true);
      expect(h.toast).toHaveBeenCalledWith("Every channel on this server now recalls it (#9)");
      expect(h.go).toHaveBeenCalledWith("#/c/dev/knowledge/9");
    });
  });

  it("hides Share for a server-wide entry and shows the moved note instead of actions", async () => {
    const { container } = renderHuddle(
      <Knowledge prefs={prefs} />,
      { ch: "dev" },
      1,
      kbFetch({ entry: { ...ENTRY, scope: "server", origin: "other" } }),
    );
    await readerLoaded();
    expect(screen.queryByText("Share with every channel")).toBeNull();
    expect(container.querySelector(".c-info")?.getAttribute("title")).toBe(
      "From channel other; every channel on this server recalls it",
    );
    container.remove();
    const moved = renderHuddle(
      <Knowledge prefs={prefs} />,
      { ch: "dev" },
      1,
      kbFetch({ entry: { ...ENTRY, moved_to: 5 } }),
    );
    await moved.findByText("This entry is now for every channel:");
    expect(moved.container.querySelector("#kbr")?.textContent).toContain("#5");
    expect(moved.container.querySelector("[data-kbv]")).toBeNull();
    expect(moved.container.querySelector("[data-kbs]")).toBeNull();
  });

  it("shows the replaced pill and the supersedes link", async () => {
    const { container } = renderHuddle(
      <Knowledge prefs={prefs} />,
      { ch: "dev" },
      1,
      kbFetch({ entry: { ...ENTRY, superseded_by: 9, supersedes: 1 } }),
    );
    await readerLoaded();
    expect(container.querySelector("#kbr")?.textContent).toContain("Replaced by #9");
    expect(container.querySelector("#kbr")?.textContent).toContain("replaces #1");
  });

  it("renders the nothing-remembered empty state when the entry is missing", async () => {
    renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, kbFetch({ rows: [] }));
    await screen.findByText("Nothing remembered yet");
    expect(
      screen.getByText(
        "Sessions call remember when they learn something the others should not pay for again.",
      ),
    ).not.toBeNull();
  });

  it("opens the entry the route names and hides the list column on small screens", async () => {
    const fetchFn = kbFetch({});
    const { container } = renderHuddle(<Knowledge id={2} prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await readerLoaded();
    expect(fetchFn.mock.calls.some(([u]) => u === "/api/c/dev/kb/2")).toBe(true);
    expect(container.querySelector("#kblist")?.className).toContain("panel");
    expect(
      container.querySelector("#kbr section, #kbr article, #kbr .panel") ??
        container.querySelector("#kbr .panel"),
    ).toBeTruthy();
    expect(container.querySelector("#kbr")?.className).not.toContain("max-lg:hidden");
  });

  it("answers a route-named entry the server does not know with the empty state", async () => {
    renderHuddle(<Knowledge id={7} prefs={prefs} />, { ch: "dev" }, 1, kbFetch({}));
    await screen.findByText("Nothing remembered yet");
  });

  it("answers a route-named entry that fails to load with the empty state", async () => {
    renderHuddle(
      <Knowledge id={7} prefs={prefs} />,
      { ch: "dev" },
      1,
      kbFetch({ fail: ["/api/c/dev/kb/7"] }),
    );
    await screen.findByText("Nothing remembered yet");
  });

  it("recovers from a failing entry, goes to a kind and back to All", async () => {
    const fetchFn = kbFetch({ fail: ["/api/c/dev/kb/2"] });
    renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await screen.findByText("Nothing remembered yet");
    fireEvent.click(screen.getByText("How-to"));
    await vi.waitFor(() => {
      expect(fetchFn.mock.calls.some(([u]) => u === "/api/c/dev/kb?q=&kind=howto&limit=50")).toBe(true);
    });
    fireEvent.click(screen.getByText("All"));
    await vi.waitFor(() => {
      expect(fetchFn.mock.calls.filter(([u]) => u === KB).length).toBeGreaterThan(1);
    });
  });

  it("toasts a failing share", async () => {
    const h = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, kbFetch({ fail: [SHARE] }));
    await readerLoaded();
    fireEvent.click(screen.getByText("Share with every channel"));
    await vi.waitFor(() => {
      expect(h.toast).toHaveBeenCalledWith("boom", { bad: true });
    });
  });

  it("renders a bare reader: one read, no task, no tags, no references", async () => {
    const bare: KbEntry = { id: 3, kind: "context", title: "Bare entry", body: "b", by: "bob", hits: 1 };
    const { container } = renderHuddle(
      <Knowledge prefs={prefs} />,
      { ch: "dev" },
      1,
      kbFetch({ rows: [bare], entry: bare }),
    );
    await vi.waitFor(() => expect(container.querySelector("#kbr article")).not.toBeNull());
    const card = container.querySelector("#kbr article");
    expect(card?.textContent).toContain("read 1 time");
    expect(card?.textContent).not.toContain("· task");
    expect(card?.textContent).not.toContain("References");
    expect(container.querySelector("#kbr .badge:not(.c-lavender)")).toBeNull();
  });

  it("verifies without a verifier's name and lists an entry without a hit or marks", async () => {
    const anonymous: KbEntry = { ...ENTRY, verified_at: "2026-09-18T11:00:00Z", verified_by: null };
    const rowless: KbEntry = { id: 4, kind: "fact", title: "No hit", body: "b", by: "bob" };
    const { container } = renderHuddle(
      <Knowledge prefs={prefs} />,
      { ch: "dev" },
      1,
      kbFetch({ rows: [anonymous, rowless], entry: anonymous }),
    );
    await screen.findByText("No hit");
    await vi.waitFor(() => expect(container.querySelector("#kbr article")).not.toBeNull());
    expect(container.querySelector(".badge-success")?.getAttribute("title")).toBe("Verified by ");
    expect(container.querySelector("#kbr article")?.textContent).toContain("Verified by");
    const row = screen.getByText("No hit").closest("a");
    expect(row?.querySelector("mark")).toBeNull();
    expect(row?.querySelector(".badge-success, .c-info")).toBeNull();
  });

  it("splits an unbalanced closing marker and answers a null list", async () => {
    const { container } = renderHuddle(<Hits text="oops»" />);
    expect(container.textContent).toBe("oops");
    expect(container.querySelector("mark")).toBeNull();
    const fetchFn = vi.fn(
      async (): Promise<Response> =>
        new Response("null", { headers: { "content-type": "application/json" } }),
    );
    renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await screen.findByText("No entry matches");
  });

  it("names a non-Error failure and reads the same entry again when a share keeps its id", async () => {
    const fetchFn = vi.fn(async (url: string): Promise<Response> => {
      const json = (v: unknown): Response =>
        new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
      if (/\/kb\?/.test(url)) return json([{ ...ENTRY, id: 5 }]);
      if (url === "/api/c/dev/kb/5") return json({ ...ENTRY, id: 5 });
      if (url === SHARE) return json({});
      throw "raw refusal";
    });
    const h = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await h.findByText("Export");
    fireEvent.click(h.getByText("Export"));
    fireEvent.click(h.getByText("Copy as Markdown for CLAUDE.md"));
    await vi.waitFor(() => {
      expect(h.toast).toHaveBeenCalledWith("raw refusal", { bad: true });
    });
    fireEvent.click(h.getByText("Share with every channel"));
    await vi.waitFor(() => {
      expect(h.toast).toHaveBeenCalledWith("Every channel on this server now recalls it (#undefined)");
      expect(fetchFn.mock.calls.filter(([u]) => u === "/api/c/dev/kb/5")).toHaveLength(2);
      expect(h.go).not.toHaveBeenCalled();
    });
  });

  it("verifies through a non-Error failure too", async () => {
    const fetchFn = vi.fn(async (url: string): Promise<Response> => {
      const json = (v: unknown): Response =>
        new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
      if (/\/kb\?/.test(url)) return json([{ ...ENTRY, id: 5 }]);
      if (url === "/api/c/dev/kb/5") return json({ ...ENTRY, id: 5 });
      throw "raw refusal";
    });
    const h = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await h.findByText("Verify");
    fireEvent.click(h.getByText("Verify"));
    await vi.waitFor(() => {
      expect(h.toast).toHaveBeenCalledWith("raw refusal", { bad: true });
    });
    expect((h.getByText("Verify") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(h.getByText("Share with every channel"));
    await vi.waitFor(() => {
      expect(h.toast).toHaveBeenCalledWith("raw refusal", { bad: true });
    });
  });

  it("ignores a stale list and a stale entry answer once the view has moved on", async () => {
    const { fetchFn, firstList, heldEntry } = staleKbFetch();
    const h = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await h.findByText("Nothing remembered yet");
    fireEvent.input(h.getByLabelText("Search knowledge"), { target: { value: "x" } });
    await h.findByText("Second entry");
    await vi.waitFor(() => {
      expect(fetchFn.mock.calls.some(([u]) => u === "/api/c/dev/kb/2")).toBe(true);
    });
    fireEvent.click(h.getByText("How-to"));
    await vi.waitFor(() => {
      expect(h.container.querySelector("#kblist")?.textContent).not.toContain("Second entry");
    });
    await new Promise((r) => setTimeout(r, 0));
    firstList.give(jsonResponse({ error: "late" }, 500));
    heldEntry.give(jsonResponse(ENTRY));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.container.querySelector("#kblist")?.textContent).toContain("First entry");
    expect(h.container.querySelector("#kbr article")).not.toBeNull();
  });

  it("drops a stale failing entry answer the same way", async () => {
    const { fetchFn, heldEntry } = staleKbFetch();
    const h = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await h.findByText("Nothing remembered yet");
    fireEvent.input(h.getByLabelText("Search knowledge"), { target: { value: "x" } });
    await h.findByText("Second entry");
    await vi.waitFor(() => {
      expect(fetchFn.mock.calls.some(([u]) => u === "/api/c/dev/kb/2")).toBe(true);
    });
    fireEvent.click(h.getByText("How-to"));
    await vi.waitFor(() => {
      expect(h.container.querySelector("#kblist")?.textContent).not.toContain("Second entry");
    });
    heldEntry.give(jsonResponse({ error: "late" }, 500));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.container.querySelector("#kbr article")).not.toBeNull();
  });

  it("renders nothing without an open channel", () => {
    const { container } = renderHuddle(<Knowledge prefs={prefs} />, {}, 1, kbFetch({}));
    expect(container.querySelector("#kblist")).toBeNull();
  });
});

describe("Knowledge export", () => {
  it("opens the menu on Export and closes it after an action", async () => {
    const { copy } = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, kbFetch({}));
    await listLoaded();
    const btn = screen.getByText("Export").closest("button");
    expect(btn?.getAttribute("aria-haspopup")).toBe("menu");
    expect(btn?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByText("Export"));
    expect(screen.getByRole("menu")).not.toBeNull();
    expect(btn?.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByText("Copy as Markdown for CLAUDE.md"));
    await vi.waitFor(() => {
      expect(copy).toHaveBeenCalledWith("# Knowledge\n- a", "Copied. Paste it into the project's CLAUDE.md.");
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("copies the verified entries only", async () => {
    const { copy } = renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, kbFetch({}));
    await listLoaded();
    fireEvent.click(screen.getByText("Export"));
    fireEvent.click(screen.getByText("Copy verified entries only"));
    await vi.waitFor(() => {
      expect(copy).toHaveBeenCalledWith("# Verified", "Copied the verified entries.");
    });
  });

  it("downloads the markdown through an object URL", async () => {
    const create = vi.fn(() => "blob:x");
    vi.spyOn(URL, "createObjectURL").mockImplementation(create);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const fetchFn = kbFetch({});
    renderHuddle(<Knowledge prefs={prefs} />, { ch: "dev" }, 1, fetchFn);
    await listLoaded();
    fireEvent.click(screen.getByText("Export"));
    fireEvent.click(screen.getByText("Download .md"));
    await vi.waitFor(() => {
      expect(create).toHaveBeenCalled();
      expect(fetchFn.mock.calls.some(([u]) => u === "/api/c/dev/knowledge.md")).toBe(true);
    });
    // the object URL is let go once the browser has had the click
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });

  it("names the download after the channel in ExportActions", async () => {
    const save = vi.fn();
    renderHuddle(<ExportActions ch="dev" md={() => Promise.resolve("# MD")} save={save} onDone={() => {}} />);
    fireEvent.click(screen.getByText("Download .md"));
    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledWith("# MD", "dev-knowledge.md");
    });
  });

  it("toasts a failing export", async () => {
    const h = renderHuddle(
      <Knowledge prefs={prefs} />,
      { ch: "dev" },
      1,
      kbFetch({ fail: ["/api/c/dev/knowledge.md"] }),
    );
    await listLoaded();
    fireEvent.click(screen.getByText("Export"));
    fireEvent.click(screen.getByText("Copy as Markdown for CLAUDE.md"));
    await vi.waitFor(() => {
      expect(h.toast).toHaveBeenCalledWith("boom", { bad: true });
    });
  });
});

describe("kb helpers", () => {
  it("kbAge words the age and stays silent under a day", () => {
    expect(kbAge({ age_days: 0 })).toBe("");
    expect(kbAge({ age_days: 1 })).toBe("1 day old");
    expect(kbAge({ age_days: 3 })).toBe("3 days old");
    expect(kbAge({})).toBe("");
  });

  it("kbMarks lists verified, every-channel and stale, and nothing without them", () => {
    expect(kbMarks(ENTRY)).toEqual([]);
    expect(
      kbMarks({ ...ENTRY, verified_at: "a", verified_by: "o", scope: "server", stale: "s" }).length,
    ).toBe(3);
  });

  it("KbTag names the known kinds and falls back for an unknown one", () => {
    const { container } = renderHuddle(
      <div>
        <KbTag kind="howto" />
        <KbTag kind="mystery" />
      </div>,
    );
    expect(container.textContent).toContain("How-to");
    expect(container.textContent).toContain("mystery");
    expect(container.querySelectorAll(".c-lavender").length).toBe(2);
  });

  it("Hits draws the search markers as <mark>, plain or unbalanced", () => {
    const plain = renderHuddle(<Hits text="no markers" />);
    expect(plain.container.textContent).toBe("no markers");
    expect(plain.container.querySelector("mark")).toBeNull();
    const marked = renderHuddle(<Hits text="the «port» to use" />);
    expect(marked.container.querySelector("mark")?.textContent).toBe("port");
    const unbalanced = renderHuddle(<Hits text="«oops" />);
    expect(unbalanced.container.textContent).toBe("oops");
    expect(unbalanced.container.querySelector("mark")).toBeNull();
  });
});
