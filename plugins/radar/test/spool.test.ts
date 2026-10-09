import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listSpoolFiles, parseSpoolLine, readSpoolLines } from "../src/ingest/spool.ts";
import { makeEnv, writeText } from "./helpers.ts";

const NOW = new Date("2026-01-15T00:00:00Z");

function writeSpool(env: NodeJS.ProcessEnv, name: string, lines: string[]): string {
  return writeText(join(env.RADAR_HOME ?? "", "spool", name), `${lines.join("\n")}\n`);
}

describe("listSpoolFiles", () => {
  it("returns nothing when the spool dir does not exist yet", () => {
    const { env } = makeEnv();
    expect(listSpoolFiles(env, NOW)).toEqual([]);
  });

  it("keeps datestamp files inside the window, oldest first, as full paths", () => {
    const { env, state } = makeEnv();
    writeSpool(env, "2026-01-14.jsonl", ["{}"]);
    writeSpool(env, "2026-01-08.jsonl", ["{}"]);
    writeSpool(env, "2026-01-07.jsonl", ["{}"]); // exactly cutoff - 1 day: still kept
    expect(listSpoolFiles(env, NOW)).toEqual([
      join(state, "spool", "2026-01-07.jsonl"),
      join(state, "spool", "2026-01-08.jsonl"),
      join(state, "spool", "2026-01-14.jsonl"),
    ]);
  });

  it("drops files older than the window and names that are not datestamps", () => {
    const { env } = makeEnv();
    writeSpool(env, "2026-01-06.jsonl", ["{}"]);
    writeSpool(env, "2025-12-25.jsonl", ["{}"]);
    writeSpool(env, "notes.txt", ["{}"]);
    writeSpool(env, "yesterday.jsonl", ["{}"]);
    expect(listSpoolFiles(env, NOW)).toEqual([]);
  });

  it("honours a custom day window", () => {
    const { env, state } = makeEnv();
    writeSpool(env, "2026-01-12.jsonl", ["{}"]);
    writeSpool(env, "2026-01-01.jsonl", ["{}"]);
    expect(listSpoolFiles(env, NOW, 3)).toEqual([join(state, "spool", "2026-01-12.jsonl")]);
  });
});

describe("parseSpoolLine", () => {
  it("accepts an object with string ts and event", () => {
    expect(parseSpoolLine('{"ts":"2026-01-01T00:00:00.000Z","event":"Stop"}')).toEqual({
      ts: "2026-01-01T00:00:00.000Z",
      event: "Stop",
    });
  });

  it("rejects missing fields, arrays, scalars and broken JSON", () => {
    expect(parseSpoolLine('{"event":"Stop"}')).toBeNull();
    expect(parseSpoolLine('{"ts":"2026-01-01T00:00:00.000Z"}')).toBeNull();
    expect(parseSpoolLine('{"ts":true,"event":"Stop"}')).toBeNull();
    expect(parseSpoolLine("[1,2]")).toBeNull();
    expect(parseSpoolLine('"line"')).toBeNull();
    expect(parseSpoolLine("{not json")).toBeNull();
    expect(parseSpoolLine("")).toBeNull();
  });

  it("reads an epoch-millisecond ts (a router may stamp one) as ISO", () => {
    expect(parseSpoolLine('{"ts":1767225600000,"event":"router.event"}')?.ts).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("keeps unknown fields for forward compatibility", () => {
    const parsed = parseSpoolLine('{"ts":"2026-01-01T00:00:00.000Z","event":"route","wat":true}');
    expect(parsed?.wat).toBe(true);
  });
});

describe("readSpoolLines", () => {
  it("reads every parseable line across files in order and skips the rest", () => {
    const { env } = makeEnv();
    writeSpool(env, "2026-01-01.jsonl", [
      '{"ts":"2026-01-01T00:00:01.000Z","event":"SessionStart"}',
      "garbage",
      '{"ts":"2026-01-01T00:00:02.000Z","event":"Stop"}',
    ]);
    writeSpool(env, "2026-01-02.jsonl", ['{"ts":"2026-01-02T00:00:00.000Z","event":"Notification"}']);
    const lines = readSpoolLines(listSpoolFiles(env, NOW, 30));
    expect(lines.map((line) => line.event)).toEqual(["SessionStart", "Stop", "Notification"]);
  });

  it("skips unreadable files without failing the readable ones", () => {
    const { env } = makeEnv();
    writeSpool(env, "2026-01-02.jsonl", ['{"ts":"2026-01-02T00:00:00.000Z","event":"Stop"}']);
    const paths = [join(env.RADAR_HOME ?? "", "spool", "2026-01-01.jsonl"), ...listSpoolFiles(env, NOW, 30)];
    expect(readSpoolLines(paths)).toHaveLength(1);
  });
});
