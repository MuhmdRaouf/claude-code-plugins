import { describe, expect, it } from "vitest";
import {
  applyInitial,
  browserTimers,
  createDrafts,
  type Draft,
  draftKey,
  localDraftStorage,
} from "../../src/compose/drafts.ts";
import type { Storage } from "../../src/storage.ts";
import type { Timers } from "../../src/store.ts";

// ── fakes: a storage that remembers, and timers that only run when told ──────
const memStorage = () => {
  const m = new Map<string, string>();
  let writes = 0;
  const storage: Storage = {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      writes += 1;
      m.set(k, v);
    },
  };
  return { storage, m, writes: () => writes };
};

const manualTimers = () => {
  const jobs = new Map<number, () => void>();
  let seq = 0;
  const timers: Timers = {
    after: (fn) => {
      jobs.set(++seq, fn);
      return seq;
    },
    cancel: (h) => void jobs.delete(h as number),
    interval: () => 0,
    stop: () => {},
  };
  return {
    timers,
    run: () => {
      for (const fn of [...jobs.values()]) fn();
    },
    pending: () => jobs.size,
  };
};

describe("draftKey", () => {
  it("names the draft per channel and place", () => {
    expect(draftKey("lab", "dlg")).toBe("draft:lab:dlg");
    expect(draftKey("lab", "s:scan.agent")).toBe("draft:lab:s:scan.agent");
  });
});

describe("createDrafts", () => {
  it("hands a fresh draft to an unknown channel + place", () => {
    const { storage } = memStorage();
    const drafts = createDrafts(storage, manualTimers().timers);
    expect(drafts.draft("lab", "dlg")).toEqual({
      to: "",
      mode: "msg",
      msg: "",
      title: "",
      after: [],
      about: [],
      phase: null,
      reply: null,
    });
  });

  it("returns the same object for the same key and a different one per place", () => {
    const drafts = createDrafts(memStorage().storage, manualTimers().timers);
    const a = drafts.draft("lab", "dlg");
    expect(drafts.draft("lab", "dlg")).toBe(a);
    expect(drafts.draft("lab", "s:x")).not.toBe(a);
    expect(drafts.draft("other", "dlg")).not.toBe(a);
  });

  it("restores a stored draft over the defaults, per channel and place", () => {
    const { storage, m } = memStorage();
    m.set("huddle:draft:lab:dlg", JSON.stringify({ msg: "half written", to: "scan.agent", after: ["t1"] }));
    const drafts = createDrafts(storage, manualTimers().timers);
    expect(drafts.draft("lab", "dlg")).toEqual({
      to: "scan.agent",
      mode: "msg",
      msg: "half written",
      title: "",
      after: ["t1"],
      about: [],
      phase: null,
      reply: null,
    });
  });

  it("never hands out a stored list by reference", () => {
    const { storage, m } = memStorage();
    m.set("huddle:draft:lab:dlg", JSON.stringify({ after: ["t1"], about: ["t2"] }));
    const drafts = createDrafts(storage, manualTimers().timers);
    const d = drafts.draft("lab", "dlg");
    d.after.push("t9");
    d.about.push("t8");
    const fresh = createDrafts(storage, manualTimers().timers).draft("lab", "dlg");
    expect(fresh.after).toStrictEqual(["t1"]);
    expect(fresh.about).toStrictEqual(["t2"]);
  });

  it("saves after the debounce lands, under huddle:draft:<ch>:<place>", () => {
    const { storage, m, writes } = memStorage();
    const t = manualTimers();
    const drafts = createDrafts(storage, t.timers);
    drafts.draft("lab", "dlg").msg = "hello";
    drafts.save("lab", "dlg");
    expect(writes()).toBe(0);
    expect(t.pending()).toBe(1);
    t.run();
    expect(writes()).toBe(1);
    expect(m.get("huddle:draft:lab:dlg")).toContain("hello");
  });

  it("replaces a pending save instead of queueing another", () => {
    const { storage } = memStorage();
    const t = manualTimers();
    const drafts = createDrafts(storage, t.timers);
    const d = drafts.draft("lab", "dlg");
    d.msg = "one";
    drafts.save("lab", "dlg");
    d.msg = "two";
    drafts.save("lab", "dlg");
    expect(t.pending()).toBe(1);
    t.run();
    expect(JSON.parse(storage.getItem("huddle:draft:lab:dlg") ?? "{}")).toMatchObject({ msg: "two" });
  });

  it("saves each place separately", () => {
    const { storage } = memStorage();
    const t = manualTimers();
    const drafts = createDrafts(storage, t.timers);
    drafts.draft("lab", "dlg").msg = "dialog";
    drafts.draft("lab", "s:scan.agent").msg = "drawer";
    drafts.save("lab", "dlg");
    drafts.save("lab", "s:scan.agent");
    t.run();
    expect(JSON.parse(storage.getItem("huddle:draft:lab:dlg") ?? "{}")).toMatchObject({ msg: "dialog" });
    expect(JSON.parse(storage.getItem("huddle:draft:lab:s:scan.agent") ?? "{}")).toMatchObject({
      msg: "drawer",
    });
  });

  it("flush writes every pending draft now, dispose drops them", () => {
    const { storage, writes } = memStorage();
    const t = manualTimers();
    const flushed = createDrafts(storage, t.timers);
    flushed.draft("lab", "dlg").msg = "keep";
    flushed.save("lab", "dlg");
    flushed.flush();
    expect(writes()).toBe(1);
    expect(t.pending()).toBe(0);
    expect(JSON.parse(storage.getItem("huddle:draft:lab:dlg") ?? "{}")).toMatchObject({ msg: "keep" });

    const dropped = createDrafts(storage, t.timers);
    dropped.draft("lab", "dlg").msg = "gone";
    dropped.save("lab", "dlg");
    dropped.dispose();
    expect(t.pending()).toBe(0);
    expect(JSON.parse(storage.getItem("huddle:draft:lab:dlg") ?? "{}")).toMatchObject({ msg: "keep" });
  });

  it("survives a round trip through the storage", () => {
    const { storage } = memStorage();
    const first = createDrafts(storage, manualTimers().timers);
    const d = first.draft("lab", "s:scan.agent");
    d.msg = "coming back";
    d.mode = "task";
    d.title = "Fix it";
    d.after = ["t1", "t2"];
    d.phase = 2;
    first.save("lab", "s:scan.agent");
    first.flush();
    const second = createDrafts(storage, manualTimers().timers);
    expect(second.draft("lab", "s:scan.agent")).toEqual({
      to: "",
      mode: "task",
      msg: "coming back",
      title: "Fix it",
      after: ["t1", "t2"],
      about: [],
      phase: 2,
      reply: null,
    });
  });
});

describe("applyInitial", () => {
  const base = (): Draft => ({
    to: "",
    mode: "msg",
    msg: "",
    title: "",
    after: [],
    about: [],
    phase: null,
    reply: null,
  });

  it("pins the reply when one is given", () => {
    const d = base();
    applyInitial(d, { reply: 7 });
    expect(d.reply).toBe(7);
    expect(d.mode).toBe("msg");
  });

  it("keeps 0 as a reply", () => {
    const d = base();
    applyInitial(d, { reply: 0 });
    expect(d.reply).toBe(0);
  });

  it("a plain open cancels a pending reply and keeps to and mode", () => {
    const d: Draft = { ...base(), to: "scan.agent", mode: "ask", reply: 7 };
    applyInitial(d, {});
    expect(d.reply).toBeNull();
    expect(d.to).toBe("scan.agent");
    expect(d.mode).toBe("ask");
  });

  it("applies to and mode only when given, and an empty to clears the recipient", () => {
    const d: Draft = { ...base(), to: "scan.agent", mode: "msg" };
    applyInitial(d, { mode: "task" });
    expect(d.mode).toBe("task");
    expect(d.to).toBe("scan.agent");
    applyInitial(d, { to: "" });
    expect(d.to).toBe("");
  });

  it("wraps about into the about list and replaces after", () => {
    const d: Draft = { ...base(), about: ["t9"], after: ["t1"] };
    applyInitial(d, { about: "t2", after: ["t3", "t4"] });
    expect(d.about).toStrictEqual(["t2"]);
    expect(d.after).toStrictEqual(["t3", "t4"]);
  });

  it("leaves about and after alone when not given", () => {
    const d: Draft = { ...base(), about: ["t1"], after: ["t2"] };
    applyInitial(d, { mode: "task" });
    expect(d.about).toStrictEqual(["t1"]);
    expect(d.after).toStrictEqual(["t2"]);
  });

  it("applies the phase when given, keeps it when not", () => {
    const d = base();
    applyInitial(d, { phase: 3 });
    expect(d.phase).toBe(3);
    applyInitial(d, {});
    expect(d.phase).toBe(3);
  });
});

describe("defaults for the page", () => {
  it("hands out a working storage even where site data is blocked", () => {
    const s = localDraftStorage();
    expect(typeof s.getItem).toBe("function");
    s.setItem("huddle:probe", "1");
    expect(["1", null]).toContain(s.getItem("huddle:probe"));
  });

  it("hands out a sink when even touching localStorage throws", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("site data is blocked");
      },
    });
    try {
      const s = localDraftStorage();
      expect(s.getItem("huddle:anything")).toBeNull();
      s.setItem("huddle:anything", "1");
    } finally {
      Object.defineProperty(globalThis, "localStorage", original as PropertyDescriptor);
    }
  });

  it("offers browser timers that schedule and cancel", () => {
    expect(typeof browserTimers.after).toBe("function");
    const h = browserTimers.after(() => {}, 10_000);
    expect(h).toBeTruthy();
    browserTimers.cancel(h);
    browserTimers.stop(browserTimers.interval(() => {}, 10_000));
  });
});
