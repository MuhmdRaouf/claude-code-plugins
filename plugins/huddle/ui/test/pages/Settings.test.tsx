// Settings.test.tsx — the channel's settings: the saved values, the save calls with their args,
// the refusals said in the form, the turn options, this browser's switches and the exports.
import { act } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, ApiOptions } from "../../src/api.ts";
import { HuddleProvider } from "../../src/app/context.tsx";
import { type NotifySwitch, Settings, startOptions } from "../../src/pages/Settings.tsx";
import type { ChannelInfo, HuddleState, HuddleStore } from "../../src/store.ts";
import { flush, makeCtx, makeState, renderIn, sess } from "../helpers.tsx";

beforeEach(() => {
  localStorage.clear();
  location.hash = "#/c/ch/settings";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The channel row the settings read on open. */
const INFO = {
  name: "ch",
  views: ["code"],
  stats: { events: 11, tasks: 3, knowledge: 4 },
  config: {
    title: "Checkout",
    description: "the next version",
    members: ["api", "web"],
    created_at: "2026-10-01T09:00:00Z",
    handover: { api: { to: "web" } },
  },
};

/** An api fake that remembers the op calls and serves the channel row. */
function apiFake(
  over: { info?: unknown; opError?: Error } = {},
): Api & { ops: Array<{ ch: string; name: string; args: unknown }> } {
  const ops: Array<{ ch: string; name: string; args: unknown }> = [];
  return {
    ops,
    api: vi.fn((path: string, _o?: ApiOptions) =>
      path.endsWith("/attention")
        ? Promise.resolve({ asks: [], gates: [], paused: [], blocked: [] })
        : Promise.resolve(over.info ?? INFO),
    ),
    op: (ch, name, args) => {
      if (over.opError) return Promise.reject(over.opError);
      ops.push({ ch, name, args });
      return Promise.resolve({});
    },
    channelPath: (ch, p) => `/api/c/${ch}${p}`,
    channelHref: (ch, p) => `#/c/${ch}${p}`,
  };
}

const notifyFake = (on = false): NotifySwitch & { toggles: number } => {
  const sw = { on: () => on, toggles: 0, toggle: async () => {} };
  return Object.assign(sw, {
    toggle: () => {
      sw.toggles += 1;
      return Promise.resolve();
    },
  });
};

/** A store fake whose channel-row read the test can watch. */
function storeFake(): { store: HuddleStore; loadInfo: ReturnType<typeof vi.fn> } {
  const loadInfo = vi.fn(async () => {});
  return { store: { loadInfo } as unknown as HuddleStore, loadInfo };
}

/** Renders the page over the state's channel row, an api fake and a store fake. */
function mount(over: { api?: ReturnType<typeof apiFake>; notify?: NotifySwitch; state?: HuddleState } = {}) {
  const api = over.api ?? apiFake();
  const notify = over.notify ?? notifyFake();
  const { store, loadInfo } = storeFake();
  const state =
    over.state ??
    makeState({
      info: INFO as ChannelInfo,
      sessions: { sessions: [sess({ name: "api" }), sess({ name: "sub.api", parent: "api" })] },
    });
  const view = renderIn(<Settings notify={notify} store={store} />, makeCtx(state, { api }));
  return { api, notify, view, store, loadInfo };
}

/** The form of a card, found by its id. */
const form = (id: string): HTMLFormElement => document.getElementById(id) as HTMLFormElement;
const field = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;

describe("the page", () => {
  it("renders the channel row the store already holds, without a fetch of its own", async () => {
    const { api } = mount();
    await flush();
    expect(document.querySelector("#f-ch")).not.toBeNull();
    expect(field("cf-title").value).toBe("Checkout");
    expect(api.api).not.toHaveBeenCalled();
  });

  it("follows the live channel row: a store refresh shows in the forms", async () => {
    const { view } = mount();
    await flush();
    // another session saved a new title while this page was open: the store says so
    const live = makeState({
      info: { ...INFO, config: { ...INFO.config, title: "Renamed by another session" } } as ChannelInfo,
      sessions: { sessions: [sess({ name: "api" }), sess({ name: "sub.api", parent: "api" })] },
    });
    view.rerender(
      <HuddleProvider value={makeCtx(live)}>
        <Settings
          notify={notifyFake()}
          store={{ loadInfo: vi.fn(async () => {}) } as unknown as HuddleStore}
        />
      </HuddleProvider>,
    );
    expect(field("cf-title").value).toBe("Renamed by another session");
  });

  it("prefills the channel, turn and repo forms from the config", async () => {
    mount();
    await flush();
    expect(field("cf-title").value).toBe("Checkout");
    expect((field("cf-desc") as unknown as HTMLTextAreaElement).value).toBe("the next version");
    expect(field("cf-members").value).toBe("api, web");
    expect(field("cf-start").value).toBe("");
    expect((field("cf-hand") as unknown as HTMLTextAreaElement).value).toBe(
      '{\n  "api": {\n    "to": "web"\n  }\n}',
    );
    expect(field("cf-repo").value).toBe("");
    expect(document.body.textContent).toContain("Available now: code.");
  });

  it("shows the orchestrator field only when the config carries the key", async () => {
    mount({
      state: makeState({
        info: { ...INFO, config: { ...INFO.config, orchestrator: "api" } } as ChannelInfo,
        sessions: { sessions: [sess({ name: "api" }), sess({ name: "sub.api", parent: "api" })] },
      }),
    });
    await flush();
    const orch = document.getElementById("cf-orch") as HTMLSelectElement;
    expect(orch).not.toBeNull();
    expect([...orch.options].map((o) => o.textContent)).toEqual(["None", "api", "web"]);
    expect(orch.selectedOptions[0]?.textContent).toBe("api");
    expect(document.body.textContent).toContain("The orchestrator plans the work");
  });

  it("says the repo help's three states", async () => {
    mount();
    await flush();
    expect(document.body.textContent).toContain("Available now: code.");
    const v2 = renderIn(
      <Settings
        notify={notifyFake()}
        store={{ loadInfo: vi.fn(async () => {}) } as unknown as HuddleStore}
      />,
      makeCtx(
        makeState({
          info: { ...INFO, views: [], config: { ...INFO.config, repo: "/nowhere" } } as ChannelInfo,
        }),
      ),
    );
    await flush();
    expect(v2.container.textContent).toContain("Huddle cannot read this path.");
    const v3 = renderIn(
      <Settings
        notify={notifyFake()}
        store={{ loadInfo: vi.fn(async () => {}) } as unknown as HuddleStore}
      />,
      makeCtx(makeState({ info: { ...INFO, views: [], config: { ...INFO.config } } as ChannelInfo })),
    );
    await flush();
    expect(v3.container.textContent).not.toContain("Huddle cannot read this path.");
  });

  it("renders nothing without an open channel", async () => {
    const { view } = mount({ state: makeState({ ch: null }) });
    await flush();
    expect(view.container.textContent).toBe("");
  });

  it("drops a refused save that lands after the page is gone", async () => {
    let rejectOp: (e: unknown) => void = () => {};
    const slow = {
      ...apiFake(),
      op: () =>
        new Promise((_resolve, reject) => {
          rejectOp = reject;
        }),
    } as unknown as Api;
    const { view } = mount({ api: slow as ReturnType<typeof apiFake> });
    await flush();
    form("f-ch").requestSubmit(); // a save is now in flight
    view.unmount(); // the form and its error ref are gone
    await act(async () => {
      rejectOp(new Error("too late"));
      await flush();
    });
  });
});

describe("saving", () => {
  it("saves the channel card through op/configure, toasts, and reads the row again", async () => {
    const { api, loadInfo } = mount();
    await flush();
    field("cf-title").value = "  Checkout 2  ";
    (field("cf-desc") as unknown as HTMLTextAreaElement).value = "v2";
    field("cf-members").value = "api, web,, docs";
    await act(async () => {
      form("f-ch").requestSubmit();
    });
    await flush();
    expect(api.ops).toEqual([
      {
        ch: "ch",
        name: "configure",
        args: { title: "Checkout 2", description: "v2", members: ["api", "web", "docs"] },
      },
    ]);
    // only a save reads the row again
    expect(loadInfo).toHaveBeenCalledTimes(1);
  });

  it("saves the orchestrator as null when None is picked", async () => {
    const api = apiFake();
    const { api: fake } = mount({
      api,
      state: makeState({
        info: { ...INFO, config: { ...INFO.config, orchestrator: "api" } } as ChannelInfo,
        sessions: { sessions: [sess({ name: "api" }), sess({ name: "sub.api", parent: "api" })] },
      }),
    });
    await flush();
    const orch = document.getElementById("cf-orch") as HTMLSelectElement;
    orch.value = "";
    await act(async () => {
      form("f-ch").requestSubmit();
    });
    await flush();
    expect(fake.ops[0]?.args).toEqual({
      title: "Checkout",
      description: "the next version",
      members: ["api", "web"],
      orchestrator: null,
    });
  });

  it("saves the turn with the start and the parsed hand-over rules", async () => {
    const { api } = mount();
    await flush();
    const start = document.getElementById("cf-start") as HTMLSelectElement;
    start.value = "api";
    await act(async () => {
      form("f-turn").requestSubmit();
    });
    await flush();
    expect(api.ops).toEqual([
      { ch: "ch", name: "configure", args: { start: "api", handover: { api: { to: "web" } } } },
    ]);
  });

  it("refuses hand-over rules that are not JSON, in the form, without saving", async () => {
    const { api } = mount();
    await flush();
    (field("cf-hand") as unknown as HTMLTextAreaElement).value = "{nope";
    await act(async () => {
      form("f-turn").requestSubmit();
    });
    await flush();
    const errs = [...document.querySelectorAll("#f-turn .err")];
    expect(errs[0]?.textContent).toContain("The hand-over rules are not valid JSON:");
    expect(api.ops).toEqual([]);
  });

  it("saves the repo path and profile trimmed", async () => {
    const { api } = mount();
    await flush();
    field("cf-repo").value = "  /srv/repo  ";
    field("cf-profile").value = "  web  ";
    await act(async () => {
      form("f-repo").requestSubmit();
    });
    await flush();
    expect(api.ops).toEqual([{ ch: "ch", name: "configure", args: { repo: "/srv/repo", profile: "web" } }]);
  });

  it("says the server's refusal in the form that asked", async () => {
    const api = apiFake({ opError: new Error("read-only") });
    mount({ api });
    await flush();
    await act(async () => {
      form("f-ch").requestSubmit();
    });
    await flush();
    const err = document.querySelector("#f-ch .err");
    expect(err?.textContent).toBe("read-only");
  });

  it("toasts Saved when a save lands", async () => {
    const toast = vi.fn();
    const api = apiFake();
    renderIn(<Settings notify={notifyFake()} />, makeCtx(makeState(), { api, toast }));
    await flush();
    await act(async () => {
      form("f-ch").requestSubmit();
    });
    await flush();
    expect(toast).toHaveBeenCalledWith("Saved");
  });
});

describe("this browser", () => {
  it("keeps a theme pick and presses the segment buttons", async () => {
    mount();
    await flush();
    const dark = [...document.querySelectorAll('[data-theme-set="dark"]')][0] as HTMLButtonElement;
    expect(dark.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      dark.click();
    });
    await flush();
    expect(localStorage.getItem("huddle:theme")).toBe('"dark"');
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(dark.getAttribute("aria-pressed")).toBe("true");
  });

  it("flips the notify switch and reads the browser's permission", async () => {
    const notify = notifyFake(false);
    vi.stubGlobal("Notification", { permission: "granted" });
    mount({ notify });
    await flush();
    const sw = document.getElementById("set-notif") as HTMLButtonElement;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("Browser permission: granted");
    await act(async () => {
      sw.click();
    });
    await flush();
    expect(notify.toggles).toBe(1);
    expect(sw.getAttribute("aria-checked")).toBe("false"); // the fake still says off
  });

  it("says when this browser cannot show notifications", async () => {
    const saved = (window as { Notification?: unknown }).Notification;
    Reflect.deleteProperty(window, "Notification");
    mount();
    await flush();
    expect(document.body.textContent).toContain("This browser cannot show notifications.");
    if (saved !== undefined) (window as { Notification?: unknown }).Notification = saved;
  });

  it("resets the per-viewer filters and toasts", async () => {
    localStorage.setItem("huddle:wfilter:ch", '"notes"');
    localStorage.setItem("huddle:wview:ch", '"board"');
    localStorage.setItem("huddle:theme", '"dark"');
    localStorage.setItem("other:key", "1");
    const toast = vi.fn();
    renderIn(<Settings notify={notifyFake()} />, makeCtx(makeState(), { toast }));
    await flush();
    await act(async () => {
      (document.getElementById("set-reset") as HTMLButtonElement).click();
    });
    await flush();
    expect(localStorage.getItem("huddle:wfilter:ch")).toBeNull();
    expect(localStorage.getItem("huddle:wview:ch")).toBeNull();
    expect(localStorage.getItem("huddle:theme")).toBe('"dark"');
    expect(localStorage.getItem("other:key")).toBe("1");
    expect(toast).toHaveBeenCalledWith("Filters reset");
  });
});

describe("the exports", () => {
  it("links the three exports over the channel path", async () => {
    mount();
    await flush();
    const rows = [...document.querySelectorAll('a[target="_blank"]')].filter((a) =>
      a.className.includes("hover:bg-base-content/10"),
    );
    expect(rows.map((a) => a.getAttribute("href"))).toEqual([
      "/api/c/ch/export.md",
      "/api/c/ch/plan.json",
      "/api/c/ch/timeline?limit=2000",
    ]);
    expect(rows.every((a) => a.getAttribute("rel") === "noopener")).toBe(true);
    expect(document.body.textContent).toContain("The last 2000 events");
  });
});

describe("branch corners", () => {
  it("saves an empty hand-over field as an empty object", async () => {
    const { api } = mount();
    await flush();
    (field("cf-hand") as unknown as HTMLTextAreaElement).value = "";
    await act(async () => {
      form("f-turn").requestSubmit();
    });
    await flush();
    expect(api.ops[0]?.args).toEqual({ start: "", handover: {} });
  });

  it("keeps the empty config when the store holds no channel row", async () => {
    mount({ state: makeState({ info: null }) });
    await flush();
    expect(field("cf-title").value).toBe("");
    expect(document.body.textContent).toContain("0 events");
  });
});

describe("startOptions", () => {
  it("offers nobody first, filters dotted names, and keeps a vanished value", () => {
    expect(startOptions(["api", "a.sub", "web"], "")).toEqual([
      { value: "", label: "Nobody: work in parallel", selected: true },
      { value: "api", label: "api", selected: false },
      { value: "web", label: "web", selected: false },
    ]);
    const kept = startOptions(["api"], "gone");
    expect(kept.map((o) => o.value)).toEqual(["", "api", "gone"]);
    expect(kept.find((o) => o.value === "gone")?.selected).toBe(true);
    const picked = startOptions(["api", "web"], "web");
    expect(picked.find((o) => o.value === "web")?.selected).toBe(true);
    expect(picked.find((o) => o.value === "")?.selected).toBe(false);
  });
});
