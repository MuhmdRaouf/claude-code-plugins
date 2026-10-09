import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { healthEvent, type SpoolEvent } from "../../src/domain/route-events.ts";
import {
  createSpoolWriter,
  listSpoolFiles,
  radarHome,
  readSpoolEvents,
  spoolFile,
} from "../../src/router/spool.ts";
import { tempDir } from "../support/tmp.ts";

const env = (): Record<string, string | undefined> => {
  const root = tempDir("core-spool-");
  return { HOME: join(root, "home"), RADAR_HOME: join(root, "radar") };
};

describe("the spool's paths", () => {
  it("takes RADAR_HOME over ~/.agents", () => {
    expect(radarHome({ RADAR_HOME: "/pin", HOME: "/home" })).toBe("/pin");
    expect(radarHome({ HOME: "/home" })).toBe(join("/home", ".agents", "radar"));
  });

  it("names the file for the local date, not UTC's", () => {
    // Late on the 7th in UTC+3 is still the 7th locally; in UTC-10 it is already the 8th here.
    expect(spoolFile({ RADAR_HOME: "/o" }, new Date(2026, 9, 7, 23, 30))).toBe(
      join("/o", "spool", "2026-10-07.jsonl"),
    );
    expect(spoolFile({ RADAR_HOME: "/o" }, new Date(2026, 10, 1, 0, 5))).toBe(
      join("/o", "spool", "2026-11-01.jsonl"),
    );
  });
});

describe("createSpoolWriter", () => {
  it("appends one JSON line per event to a 0600 file in a 0700 dir", () => {
    const e = env();
    // The day's file is named for the writer's clock, pinned here so the test does not depend on today's date.
    const write = createSpoolWriter(e, console.error, () => new Date(2026, 9, 7, 12));

    write({
      ts: "2026-10-07T10:00:00.000Z",
      event: "router",
      plugin: "zai",
      port: 18787,
      state: "start",
      version: 1,
    });
    write({
      ts: "2026-10-07T10:00:01.000Z",
      event: "route",
      plugin: "zai",
      model: "glm-5.3",
      upstream: "api.z.ai",
      route: "provider",
      status: 200,
      latency_ms: 42,
    });

    const file = spoolFile(e, new Date(2026, 9, 7, 12));
    expect((statSync(join(radarHome(e), "spool")).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ event: "router", state: "start" });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ event: "route", model: "glm-5.3" });
  });

  it("makes the spool directory again when Radar removed it under a running router", () => {
    const e = env();
    const warnings: string[] = [];
    const write = createSpoolWriter(e, (line) => warnings.push(line));
    const event = { ts: "t", event: "router", plugin: "zai", port: 1, state: "start", version: 1 } as const;
    write(event);
    rmSync(join(radarHome(e), "spool"), { recursive: true, force: true });
    write(event);
    expect(warnings).toEqual([]);
    expect(readdirSync(join(radarHome(e), "spool"))).toHaveLength(1);
  });

  it("swallows a failing write into one warning line", () => {
    const root = tempDir("core-spool-");
    const blocked = join(root, "radar");
    writeFileSync(blocked, "in the way");
    const warnings: string[] = [];
    const write = createSpoolWriter({ HOME: join(root, "home"), RADAR_HOME: blocked }, (line) =>
      warnings.push(line),
    );

    write({
      ts: "2026-10-07T10:00:00.000Z",
      event: "router",
      plugin: "zai",
      port: 18787,
      state: "start",
      version: 1,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("route spool:");
  });
});

describe("reading the spool back", () => {
  const route = (ts: string, plugin: string): SpoolEvent => ({
    ts,
    event: "route",
    plugin,
    model: "glm-5.3",
    upstream: "api.z.ai",
    route: "provider",
    status: 200,
    latency_ms: 5,
  });

  function spoolWith(names: readonly string[]): ReturnType<typeof env> {
    const e = env();
    for (const name of names) {
      const file = join(radarHome(e), "spool", name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(route("2026-10-07T10:00:00.000Z", "zai"))}\nnot json\n\n`);
    }
    return e;
  }

  it("lists the last days' files, today included, oldest first, and nothing when there is no spool yet", () => {
    const noon = new Date(2026, 9, 7, 12);
    const e = spoolWith(["2026-10-07.jsonl", "2026-10-06.jsonl", "2026-10-05.jsonl", "notes.txt"]);

    expect(listSpoolFiles(e, noon, 2)).toEqual([
      join(radarHome(e), "spool", "2026-10-06.jsonl"),
      join(radarHome(e), "spool", "2026-10-07.jsonl"),
    ]);
    expect(listSpoolFiles(e, noon, 1)).toEqual([join(radarHome(e), "spool", "2026-10-07.jsonl")]);
    expect(listSpoolFiles({ HOME: join(tempDir("core-spool-"), "gone") }, noon, 30)).toEqual([]);
  });

  it("reads every parseable event and skips malformed lines and unreadable files", () => {
    const e = spoolWith(["2026-10-07.jsonl"]);
    const events = readSpoolEvents(listSpoolFiles(e, new Date(2026, 9, 7, 12), 1));

    expect(events).toEqual([route("2026-10-07T10:00:00.000Z", "zai")]);
    expect(readSpoolEvents([join(radarHome(e), "spool", "nope.jsonl")])).toEqual([]);
  });

  it("reads router health lines beside route events, and skips a health line that is not one", () => {
    const e = env();
    const write = createSpoolWriter(e, console.error, () => new Date(2026, 9, 7, 12));
    const health = healthEvent("zai", "rate_limited", "HTTP 429", "glm-5.3", 1_791_000_000_000);
    write(health);
    write(healthEvent("zai", "fallback", "no worker was ready", "", 1_791_000_000_001));
    const file = spoolFile(e, new Date(2026, 9, 7, 12));
    writeFileSync(
      file,
      [
        readFileSync(file, "utf8").trimEnd(),
        JSON.stringify({ ...health, event: "exploded" }),
        JSON.stringify({ ...health, ts: "yesterday" }),
        JSON.stringify({ ...health, reason: 7, model: 8 }),
      ].join("\n"),
    );

    expect(readSpoolEvents([file])).toEqual([
      {
        kind: "router.event",
        plugin: "zai",
        event: "rate_limited",
        reason: "HTTP 429",
        model: "glm-5.3",
        ts: 1_791_000_000_000,
      },
      {
        kind: "router.event",
        plugin: "zai",
        event: "fallback",
        reason: "no worker was ready",
        model: null,
        ts: 1_791_000_000_001,
      },
      // A string ts with no event name is neither shape; a wrong reason or model type reads as none.
      {
        kind: "router.event",
        plugin: "zai",
        event: "rate_limited",
        reason: "",
        model: null,
        ts: 1_791_000_000_000,
      },
    ]);
  });
});
