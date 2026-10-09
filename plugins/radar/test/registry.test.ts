import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pidAlive, readRegistry, registryDir, registrySessionOf } from "../src/ingest/registry.ts";

let config: string;
let dir: string;

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "radar-registry-"));
  dir = join(config, "sessions");
  mkdirSync(dir);
});

afterEach(() => {
  rmSync(config, { recursive: true, force: true });
});

function write(name: string, text: string): void {
  writeFileSync(join(dir, name), text, "utf8");
}

const session = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ pid: 81_812, sessionId: "94d64de0", status: "busy", ...over });

describe("registryDir", () => {
  it("sits beside projects/ in the same Claude config dir", () => {
    expect(registryDir({ CLAUDE_CONFIG_DIR: "/cfg", HOME: "/home/u" })).toBe("/cfg/sessions");
    expect(registryDir({ HOME: "/home/u" })).toBe("/home/u/.claude/sessions");
  });
});

describe("registrySessionOf", () => {
  it("reads the fields radar names sessions and states from", () => {
    expect(
      registrySessionOf(session({ name: "ProxBeam", nameSource: "user", cwd: "/w/app", startedAt: 1_000 })),
    ).toEqual({
      pid: 81_812,
      sessionId: "94d64de0",
      name: "ProxBeam",
      nameSource: "user",
      status: "busy",
      cwd: "/w/app",
      startedAt: 1_000,
    });
    expect(registrySessionOf(session())).toEqual({
      pid: 81_812,
      sessionId: "94d64de0",
      name: null,
      nameSource: null,
      status: "busy",
      cwd: null,
      startedAt: null,
    });
    expect(registrySessionOf(session({ startedAt: "not-a-number" }))?.startedAt).toBeNull();
  });

  it("refuses anything without a session id and a positive whole pid", () => {
    expect(registrySessionOf("not json")).toBeNull();
    expect(registrySessionOf("[1,2]")).toBeNull();
    expect(registrySessionOf("42")).toBeNull();
    expect(registrySessionOf(JSON.stringify({ sessionId: "x" }))).toBeNull();
    expect(registrySessionOf(JSON.stringify({ pid: 7 }))).toBeNull();
    expect(registrySessionOf(JSON.stringify({ sessionId: "x", pid: 0 }))).toBeNull();
    expect(registrySessionOf(JSON.stringify({ sessionId: "x", pid: -3 }))).toBeNull();
    expect(registrySessionOf(JSON.stringify({ sessionId: "x", pid: 1.5 }))).toBeNull();
  });
});

describe("readRegistry", () => {
  it("lists the live sessions, dropping entries whose pid is gone", () => {
    write("81812.json", session({ sessionId: "live-one" }));
    write("81813.json", session({ pid: 81_813, sessionId: "live-two", status: "idle" }));
    write("81814.json", session({ pid: 81_814, sessionId: "dead-one" }));
    const entries = readRegistry({ CLAUDE_CONFIG_DIR: config }, (pid) => pid !== 81_814);
    expect(entries.map((entry) => entry.sessionId)).toEqual(["live-one", "live-two"]);
    expect(entries[1]).toMatchObject({ status: "idle" });
  });

  it("never reads the .key files beside the session files, nor anything but .json", () => {
    write("81812.key", session({ pid: 42, sessionId: "from-the-key" }));
    write("81812.jsonl", session({ pid: 43, sessionId: "from-the-jsonl" }));
    write("notes.txt", session({ pid: 44, sessionId: "from-the-notes" }));
    const asked: number[] = [];
    const entries = readRegistry({ CLAUDE_CONFIG_DIR: config }, (pid) => {
      asked.push(pid);
      return true;
    });
    expect(entries).toEqual([]);
    expect(asked).toEqual([]); // no secret-bearing file was even opened for parsing
  });

  it("skips a malformed or empty file and carries on with the rest", () => {
    write("a.json", "{oops");
    write("b.json", "");
    write("c.json", session({ sessionId: "good" }));
    const entries = readRegistry({ CLAUDE_CONFIG_DIR: config }, () => true);
    expect(entries.map((entry) => entry.sessionId)).toEqual(["good"]);
  });

  it("answers nothing when the registry directory does not exist or holds nothing", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(readRegistry({ CLAUDE_CONFIG_DIR: config }, () => true)).toEqual([]);
    mkdirSync(dir);
    expect(readRegistry({ CLAUDE_CONFIG_DIR: config }, () => true)).toEqual([]);
  });
});

describe("pidAlive", () => {
  it("takes this process for alive and an impossible pid for gone", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(999_999_999)).toBe(false); // beyond every pid_max this side of a mainframe
  });
});
