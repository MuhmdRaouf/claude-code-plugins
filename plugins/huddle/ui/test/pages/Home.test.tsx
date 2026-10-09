// Home.test.tsx — the channels page: the cards, the New channel dialog, the connect card and the
// 10 s poll, all over an injected api and injected timers.
import { act, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import {
  ChannelCard,
  type ChannelRow,
  ConnectCard,
  Home,
  homeData,
  type PollTimers,
} from "../../src/pages/Home.tsx";
import { flush, makeCtx, makeState, renderIn, settle, stubClipboard } from "../helpers.tsx";

beforeEach(() => {
  location.hash = "";
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An api fake over a canned answer per path. */
function apiFake(routes: Record<string, unknown> | ((path: string, body?: unknown) => unknown)): Api {
  const call = typeof routes === "function" ? routes : (path: string) => routes[path];
  return {
    api: (path: string, o?: { body?: unknown }) => {
      const r = call(path, o?.body);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
    op: () => Promise.resolve({}),
    channelPath: (ch, p) => `/api/c/${ch}${p}`,
    channelHref: (ch, p) => `#/c/${ch}${p}`,
  };
}

/** Renders the page over an explicit api; go really moves the address bar. */
function ctxWith(api: Api, over: Partial<Parameters<typeof makeCtx>[1]> = {}, timers?: PollTimers) {
  return renderIn(
    <Home {...(timers ? { timers } : {})} />,
    makeCtx(makeState({ ch: null }), { api, ...over }),
  );
}

/** A poll whose ticks the test fires by hand; it records the handle and the stop. */
function fakePoll(): PollTimers & { tick(): void; stopped(): unknown[] } {
  let fn: (() => void) | null = null;
  const stopped: unknown[] = [];
  return {
    interval: (f) => {
      fn = f;
      return "h";
    },
    stop: (h) => {
      stopped.push(h);
    },
    tick: () => fn?.(),
    stopped: () => stopped,
  };
}

const ROWS: ChannelRow[] = [
  {
    name: "busy",
    title: "Busy",
    needs: 2,
    sessions: [{ name: "api" }],
    stats: { tasks: 4, done: 1, last: 9 },
  },
  { name: "calm", needs: 0 },
];

describe("homeData", () => {
  it("counts each channel's needs and sorts: needs, then last event, then name", async () => {
    const seen: string[] = [];
    const api = apiFake((path) => {
      seen.push(path);
      if (path === "/api/channels")
        return [
          { name: "b", stats: { last: 5 } },
          { name: "a", stats: { last: 5 } },
          { name: "c", stats: { last: 9 } },
          { name: "d", needs: 0 },
        ];
      if (path === "/api/c/a/attention") return { asks: [{ seq: 1, from: "x" }] };
      if (path === "/api/c/c/attention") return { gates: [{ id: "g" }], paused: [{ name: "p" }] };
      if (path === "/api/c/d/attention") return new Error("no channel");
      return { asks: [], gates: [], paused: [], blocked: [] };
    });
    const list = await homeData(api);
    expect(list.map((c) => `${c.name}:${c.needs}`)).toEqual(["c:2", "a:1", "b:0", "d:0"]);
    expect(seen).toContain("/api/c/a/attention");
  });

  it("gives an empty list when the channel list cannot be read", async () => {
    const api = apiFake(() => new Error("down"));
    expect(await homeData(api)).toEqual([]);
  });
});

describe("the channel cards", () => {
  it("renders a card per channel: title and tid, description, needs pill, online, tasks, last event", () => {
    renderIn(
      <div>
        <ChannelCard c={ROWS[0] as ChannelRow} />
        <ChannelCard c={ROWS[1] as ChannelRow} />
      </div>,
    );
    const busy = document.querySelector('[data-ch="busy"]') as HTMLElement;
    expect(busy.getAttribute("href")).toBe("#/c/busy");
    expect(busy.textContent).toContain("Busy");
    expect(busy.querySelector(".font-mono")?.textContent).toBe("busy");
    expect(busy.textContent).toContain("2 need you");
    expect(busy.textContent).toContain("1 online");
    expect(busy.textContent).toContain("1 of 4 tasks");
    expect(busy.textContent).toContain("Last event #9");
    expect(busy.querySelector(".segbar")).not.toBeNull();
    const calm = document.querySelector('[data-ch="calm"]') as HTMLElement;
    expect(calm.textContent).toContain("All clear");
    expect(calm.textContent).toContain("No description yet.");
    expect(calm.textContent).toContain("Nobody online");
    expect(calm.textContent).toContain("No tasks yet");
    expect(calm.textContent).toContain("No events yet");
  });

  it("folds the sixth online session into a +n more badge", () => {
    const six = { sessions: ["a", "b", "c", "d", "e", "f", "g"].map((n) => ({ name: n })) };
    renderIn(<ChannelCard c={{ name: "big", ...six }} />);
    expect(document.querySelectorAll(".avatar")).toHaveLength(6); // five avatars plus the +2 disc
    expect(screen.getByTitle("2 more online").textContent).toBe("+2");
  });

  it("sorts ties by name and treats missing stats as zero", async () => {
    const api = apiFake({
      "/api/channels": [{ name: "b" }, { name: "a", needs: 1 }, { name: "z", stats: { tasks: 2 } }],
    });
    const list = await homeData(api);
    expect(list.map((c) => c.name)).toEqual(["a", "b", "z"]);
  });

  it("shows the singular need pill and an empty description", () => {
    renderIn(
      <div>
        <ChannelCard c={{ name: "solo", needs: 1, description: "" }} />
      </div>,
    );
    const card = document.querySelector('[data-ch="solo"]') as HTMLElement;
    expect(card.textContent).toContain("1 needs you");
    expect(card.textContent).toContain("No description yet.");
  });

  it("counts tasks as zero when done is missing", () => {
    renderIn(<ChannelCard c={{ name: "half", stats: { tasks: 2 } }} />);
    expect(document.body.textContent).toContain("0 of 2 tasks");
    expect((document.querySelector(".segbar-seg") as HTMLElement).style.width).toBe("0%");
  });

  it("gives an empty list when the channel list is not a list", async () => {
    const api = apiFake({ "/api/channels": null });
    expect(await homeData(api)).toEqual([]);
  });

  it("rounds the tasks bar to a whole percent", () => {
    renderIn(<ChannelCard c={{ name: "p", stats: { tasks: 3, done: 1 } }} />);
    expect((document.querySelector(".segbar-seg") as HTMLElement).style.width).toBe("33%");
  });
});

describe("the page", () => {
  it("lists the channels, or an empty state, and carries the connect card", async () => {
    const api = apiFake({ "/api/channels": ROWS });
    const { unmount } = ctxWith(api);
    await flush();
    expect(document.querySelectorAll("#chlist [data-ch]")).toHaveLength(2);
    expect(screen.getByText("Connect a session")).toBeDefined();
    expect(screen.getByText("Bring another Claude session into", { exact: false }).textContent).toContain(
      "busy",
    );
    unmount();
  });

  it("asks for an empty list when there are no channels yet", async () => {
    const api = apiFake({ "/api/channels": [] });
    const { unmount } = ctxWith(api);
    await flush();
    expect(screen.getByText("No channels yet")).toBeDefined();
    expect(screen.getByText(/Create one with New channel/)).toBeDefined();
    unmount();
  });

  it("polls every 10 s, skips a hidden tab, and stops on unmount", async () => {
    let hidden = false;
    const rows: ChannelRow[] = [{ name: "one" }];
    const api = apiFake(() => [...rows]);
    const timers = fakePoll();
    const hiddenSpy = vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const view = ctxWith(api, {}, timers);
    await flush();
    expect(document.querySelectorAll("[data-ch]")).toHaveLength(1);
    rows.push({ name: "two" });
    act(() => {
      timers.tick();
    });
    await flush();
    expect(document.querySelectorAll("[data-ch]")).toHaveLength(2);
    hidden = true;
    act(() => {
      timers.tick();
    });
    await flush();
    expect(document.querySelectorAll("[data-ch]")).toHaveLength(2);
    // a read that lands after unmount must not paint: the guard drops it
    act(() => {
      timers.tick();
    });
    view.unmount();
    await settle();
    expect(timers.stopped()).toEqual(["h"]);
    hiddenSpy.mockRestore();
  });
});

describe("the New channel dialog", () => {
  /** Opens the dialog and gives the render result and its <dialog> element. */
  const open = async (): Promise<{ view: ReturnType<typeof ctxWith>; dlg: HTMLDialogElement | null }> => {
    const api = apiFake({ "/api/channels": [] });
    const view = ctxWith(api);
    await flush();
    act(() => {
      (document.querySelector("#newch") as HTMLButtonElement).click();
    });
    await flush();
    return { view, dlg: view.baseElement.querySelector("dialog") };
  };

  it("opens with the form and closes on Cancel", async () => {
    const { dlg } = await open();
    expect(dlg?.open).toBe(true);
    expect(dlg?.querySelector("#nc-name")).not.toBeNull();
    expect(dlg?.textContent).toContain("Lowercase letters, digits and dashes");
    act(() => {
      screen.getByText("Cancel").click();
    });
    await flush();
    expect(dlg?.open).toBe(false);
  });

  it("refuses a bad name without calling the api", async () => {
    const { dlg } = await open();
    const name = dlg?.querySelector("#nc-name") as HTMLInputElement;
    name.value = "Bad Name";
    act(() => {
      screen.getByText("Create channel").click();
    });
    await flush();
    expect(dlg?.querySelector("#nc-err")?.textContent).toContain("Use 1 to 40 lowercase letters");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(dlg?.open).toBe(true);
  });

  it("creates the channel, toasts, and navigates to it", async () => {
    location.hash = "#/";
    const calls: Array<{ path: string; body: unknown }> = [];
    const api = apiFake((path, body) => {
      calls.push({ path, body });
      if (path === "/api/channels" && body) return { name: "checkout-v2" };
      if (path === "/api/channels") return [];
      return { asks: [], gates: [], paused: [], blocked: [] };
    });
    const view = ctxWith(api);
    await flush();
    act(() => {
      (document.querySelector("#newch") as HTMLButtonElement).click();
    });
    await flush();
    const dlg = view.baseElement.querySelector("dialog") as HTMLDialogElement;
    (dlg.querySelector("#nc-name") as HTMLInputElement).value = "checkout-v2";
    (dlg.querySelector("#nc-title") as HTMLInputElement).value = "Checkout 2";
    (dlg.querySelector("#nc-desc") as HTMLTextAreaElement).value = "next version";
    (dlg.querySelector("#nc-members") as HTMLInputElement).value = "api, web,, docs";
    act(() => {
      screen.getByText("Create channel").click();
    });
    await flush();
    const post = calls.find((c) => c.body);
    expect(post?.body).toEqual({
      name: "checkout-v2",
      title: "Checkout 2",
      description: "next version",
      members: ["api", "web", "docs"],
    });
    expect(location.hash).toBe("#/c/checkout-v2");
    expect(dlg.open).toBe(false);
  });

  it("omits the optional fields when they are empty", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const api = apiFake((path, body) => {
      calls.push({ path, body });
      if (path === "/api/channels" && body) return { name: "c1" };
      if (path === "/api/channels") return [];
      return { asks: [], gates: [], paused: [], blocked: [] };
    });
    const view = ctxWith(api);
    await flush();
    act(() => {
      (document.querySelector("#newch") as HTMLButtonElement).click();
    });
    await flush();
    const dlg = view.baseElement.querySelector("dialog") as HTMLDialogElement;
    (dlg.querySelector("#nc-name") as HTMLInputElement).value = "c1";
    act(() => {
      screen.getByText("Create channel").click();
    });
    await flush();
    expect(calls.find((c) => c.body)?.body).toEqual({ name: "c1", title: undefined, description: undefined });
  });

  it("says the server's refusal in the form", async () => {
    const api = apiFake((_path, body) => (body ? new Error("name taken") : []));
    const view = ctxWith(api);
    await flush();
    act(() => {
      (document.querySelector("#newch") as HTMLButtonElement).click();
    });
    await flush();
    const dlg = view.baseElement.querySelector("dialog") as HTMLDialogElement;
    (dlg.querySelector("#nc-name") as HTMLInputElement).value = "taken";
    act(() => {
      screen.getByText("Create channel").click();
    });
    await flush();
    expect(dlg.querySelector("#nc-err")?.textContent).toBe("name taken");
    expect(dlg.open).toBe(true);
  });
});

describe("the connect card", () => {
  it("shows the three steps, the MCP note and two copyable commands", async () => {
    const { writes } = stubClipboard();
    renderIn(<ConnectCard ch="ch" />);
    expect(screen.getByText("Install Huddle once per machine")).toBeDefined();
    expect(screen.getByText("Invite the session")).toBeDefined();
    expect(screen.getByText("Paste it into the other session")).toBeDefined();
    expect(screen.getByText("Other clients (MCP over HTTP)")).toBeDefined();
    expect(document.body.textContent).toContain("/plugin install huddle@muhmdraouf");
    const copies = screen.getAllByText("Copy");
    act(() => {
      copies[0]?.click();
    });
    await flush();
    expect(writes[0]).toContain("/plugin marketplace add");
  });

  it("says where the pasted command goes when the copy landed", async () => {
    const toast = vi.fn();
    stubClipboard();
    renderIn(<ConnectCard ch="ch" />, makeCtx(makeState(), { toast }));
    act(() => {
      screen.getAllByText("Copy")[0]?.click();
    });
    await flush();
    expect(toast).toHaveBeenCalledWith("Copied. Paste it where the step says.");
  });

  it("invites a session and shows the join line with its copy message", async () => {
    const { writes } = stubClipboard();
    const toast = vi.fn();
    const api = apiFake({
      "/api/tokens": { token: "tok-1", expires: "2026-10-09T12:00:00Z" },
    });
    renderIn(<ConnectCard ch="ch" />, makeCtx(makeState(), { api, toast }));
    act(() => {
      (screen.getByText("Invite a session") as HTMLButtonElement).click();
    });
    await flush();
    expect(document.querySelector("#cx-inv")?.textContent).toContain("/huddle:join");
    expect(document.querySelector("#cx-inv")?.textContent).toContain("--token tok-1");
    const buttons = [...document.querySelectorAll("#cx-inv button")] as HTMLButtonElement[];
    act(() => {
      buttons[0]?.click();
    });
    await flush();
    expect(writes[0]).toContain("tok-1");
    expect(toast).toHaveBeenCalledWith("Copied. Paste it into the other Claude session.");
  });

  it("explains a browser that may not invite", async () => {
    const api = apiFake({ "/api/tokens": Object.assign(new Error("no invites"), { status: 403 }) });
    renderIn(<ConnectCard ch="ch" />, makeCtx(makeState(), { api }));
    act(() => {
      (screen.getByText("Invite a session") as HTMLButtonElement).click();
    });
    await flush();
    expect(document.querySelector("#cx-inv")?.textContent).toContain("may not invite");
  });

  it("says other refusals as they came", async () => {
    const api = apiFake({ "/api/tokens": new Error("rate limited") });
    renderIn(<ConnectCard ch="ch" />, makeCtx(makeState(), { api }));
    act(() => {
      (screen.getByText("Invite a session") as HTMLButtonElement).click();
    });
    await flush();
    expect(document.querySelector("#cx-inv")?.textContent).toContain("rate limited");
  });

  it("toasts a blocked clipboard in red", async () => {
    const toast = vi.fn();
    stubClipboard(() => Promise.reject(new Error("blocked")));
    renderIn(<ConnectCard ch="ch" />, makeCtx(makeState(), { toast }));
    act(() => {
      screen.getAllByText("Copy")[0]?.click();
    });
    await flush();
    expect(toast).toHaveBeenCalledWith("Could not copy. Select the text and copy it by hand.", { bad: true });
  });
});
