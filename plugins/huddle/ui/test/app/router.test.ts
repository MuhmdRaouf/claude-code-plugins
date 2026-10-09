// router.test.ts — every route, alias, drawer and builder the hash router answers.
import { describe, expect, it } from "vitest";
import {
  channelHref,
  DESTS,
  type PrefReader,
  parseHash,
  pathOf,
  redirect,
  sessHref,
  taskHref,
} from "../../src/app/router.ts";

/** Reads "wview:<ch>" from a small table, so the t/ alias test can pick the last Work view. */
const reader =
  (views: Record<string, string> = {}): PrefReader =>
  (k, fb) =>
    views[k] ?? fb;

describe("parseHash: Home and channel destinations", () => {
  it("reads Home from an empty hash, #/ and anything that is not a channel's", () => {
    for (const hash of ["", "#", "#/", "#/x", "#/channels"]) {
      const r = parseHash(hash, reader());
      expect(r.dest, hash).toBe("home");
      expect(r.ch).toBeNull();
      expect(r.key).toBe("home");
      expect(r.sub).toEqual([]);
      expect(r.replace).toBeNull();
      expect(r.prefs).toEqual({});
    }
  });

  it("opens a channel on Overview when the hash names none", () => {
    for (const hash of ["#/c/ch", "#/c/ch/"]) {
      const r = parseHash(hash, reader());
      expect(r.dest).toBe("overview");
      expect(r.ch).toBe("ch");
      expect(r.replace).toBe("#/c/ch/overview");
      expect(r.key).toBe("ch/overview/");
    }
  });

  it("accepts every destination, with or without a sub path", () => {
    const expected: readonly (readonly [string, string, string[]])[] = [
      ["#/c/ch/overview", "overview", []],
      ["#/c/ch/today", "today", []],
      ["#/c/ch/inbox", "inbox", []],
      ["#/c/ch/team", "team", []],
      ["#/c/ch/work", "work", []],
      ["#/c/ch/work/list", "work", ["list"]],
      ["#/c/ch/work/board", "work", ["board"]],
      ["#/c/ch/work/graph", "work", ["graph"]],
      ["#/c/ch/work/map", "work", ["map"]],
      ["#/c/ch/work/repo/code", "work", ["repo", "code"]],
      ["#/c/ch/knowledge", "knowledge", []],
      ["#/c/ch/knowledge/12", "knowledge", ["12"]],
      ["#/c/ch/settings", "settings", []],
    ];
    for (const [hash, dest, sub] of expected) {
      const r = parseHash(hash, reader());
      expect(r.dest, hash).toBe(dest);
      expect(r.sub, hash).toEqual(sub);
      expect(r.replace, hash).toBeNull();
      expect(r.key, hash).toBe(`ch/${dest}/${sub.join("/")}`);
    }
  });

  it("reads an unknown destination as Overview and rewrites the address, keeping the query", () => {
    expect(parseHash("#/c/ch/nope", reader()).replace).toBe("#/c/ch/overview");
    expect(parseHash("#/c/ch/nope?t=7", reader())).toMatchObject({
      dest: "overview",
      replace: "#/c/ch/overview?t=7",
      task: "7",
    });
  });

  it("decodes path parts and keeps a broken escape as written", () => {
    expect(parseHash("#/c/my%20ch/inbox", reader()).ch).toBe("my ch");
    expect(parseHash("#/c/ch/%zz", reader()).dest).toBe("overview");
  });

  it("carries the two drawers, both of them when both are in the query", () => {
    expect(parseHash("#/c/ch/inbox?t=t1", reader()).task).toBe("t1");
    expect(parseHash("#/c/ch/team?s=api", reader()).sess).toBe("api");
    const both = parseHash("#/c/ch/work?t=a&s=b", reader());
    expect(both.task).toBe("a");
    expect(both.sess).toBe("b");
  });

  it("names every destination the nav offers", () => {
    expect(DESTS.map((d) => d[0])).toEqual(["inbox", "team", "work", "knowledge", "settings"]);
    expect(DESTS.map((d) => d[1])).toEqual(["Inbox", "Team", "Work", "Knowledge", "Settings"]);
  });
});

describe("parseHash: the alias redirects", () => {
  it("sends needs to Inbox and live to Team", () => {
    expect(parseHash("#/c/ch/needs", reader())).toMatchObject({ dest: "inbox", replace: "#/c/ch/inbox" });
    expect(parseHash("#/c/ch/live", reader())).toMatchObject({ dest: "team", replace: "#/c/ch/team" });
  });

  it("sends plan to Work's list, carrying the phase when one is named", () => {
    expect(parseHash("#/c/ch/plan", reader())).toMatchObject({
      dest: "work",
      sub: ["list"],
      replace: "#/c/ch/work/list",
      prefs: {},
    });
    expect(parseHash("#/c/ch/plan/p/3", reader()).prefs).toEqual({ "wphase:ch": 3 });
    expect(parseHash("#/c/ch/plan/p/-1", reader()).prefs).toEqual({ "wphase:ch": -1 });
    expect(parseHash("#/c/ch/plan/elsewhere", reader()).prefs).toEqual({});
  });

  it("sends board and graph to their Work views", () => {
    expect(parseHash("#/c/ch/board", reader()).replace).toBe("#/c/ch/work/board");
    expect(parseHash("#/c/ch/graph", reader()).replace).toBe("#/c/ch/work/graph");
  });

  it("sends review to Work's list filtered to notes", () => {
    const r = parseHash("#/c/ch/review", reader());
    expect(r.replace).toBe("#/c/ch/work/list");
    expect(r.prefs).toEqual({ "wfilter:ch": "notes" });
  });

  it("sends kb to Knowledge, onto an entry when one is named", () => {
    expect(parseHash("#/c/ch/kb", reader()).replace).toBe("#/c/ch/knowledge");
    const r = parseHash("#/c/ch/kb/12", reader());
    expect(r.replace).toBe("#/c/ch/knowledge/12");
    expect(r).toMatchObject({ dest: "knowledge", sub: ["12"] });
  });

  it("sends repo to Work's repo views", () => {
    expect(parseHash("#/c/ch/repo", reader()).replace).toBe("#/c/ch/work/repo");
    expect(parseHash("#/c/ch/repo/code", reader()).sub).toEqual(["repo", "code"]);
  });

  it("sends t/<id> to the task drawer over the channel's last Work view", () => {
    const plain = parseHash("#/c/ch/t/t1", reader());
    expect(plain.replace).toBe("#/c/ch/work/list?t=t1");
    expect(plain.task).toBe("t1");
    const boarded = parseHash("#/c/ch/t/t1", reader({ "wview:ch": "board" }));
    expect(boarded.replace).toBe("#/c/ch/work/board?t=t1");
    expect(parseHash("#/c/ch/t", reader()).replace).toBe("#/c/ch/overview");
  });
});

describe("redirect", () => {
  it("gives null for an empty tail or a word that is no alias", () => {
    expect(redirect("ch", [], reader())).toBeNull();
    expect(redirect("ch", ["nope"], reader())).toBeNull();
    expect(redirect("ch", ["t"], reader())).toBeNull();
  });

  it("encodes the task id", () => {
    expect(redirect("ch", ["t", "a b"], reader())?.to).toBe("work/list?t=a%20b");
  });
});

describe("the builders", () => {
  it("splits the drawer off the path", () => {
    expect(pathOf("#/c/ch/inbox?t=1")).toBe("#/c/ch/inbox");
    expect(pathOf("")).toBe("#/");
    expect(pathOf("#/c/ch/inbox")).toBe("#/c/ch/inbox");
  });

  it("builds the task drawer over the open view, or over Work", () => {
    expect(taskHref("ch", "#/c/ch/inbox", "t 1")).toBe("#/c/ch/inbox?t=t%201");
    expect(taskHref("ch", "#/other/x", "t1")).toBe("#/c/ch/work?t=t1");
  });

  it("builds the session drawer over the open view, or over Team", () => {
    expect(sessHref("ch", "#/c/ch/work/list", "a.pi")).toBe("#/c/ch/work/list?s=a.pi");
    expect(sessHref("ch", "#/other/x", "api")).toBe("#/c/ch/team?s=api");
  });

  it("builds a channel link", () => {
    expect(channelHref("ch")).toBe("#/c/ch");
    expect(channelHref("ch", "/inbox")).toBe("#/c/ch/inbox");
  });
});
