import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  claudeConfigDir,
  ensureStateDirs,
  fileExists,
  historyPath,
  hookErrorLog,
  publicDir,
  serverInfoPath,
  spoolDir,
  stateDir,
  stateMarkerPath,
  zaiStateDir,
} from "../src/shared/paths.ts";
import { makeEnv, writeText } from "./helpers.ts";

describe("path resolution", () => {
  it("puts everything under RADAR_HOME when it is set", () => {
    const { env, state } = makeEnv();
    expect(stateDir(env)).toBe(state);
    expect(spoolDir(env)).toBe(join(state, "spool"));
    expect(serverInfoPath(env)).toBe(join(state, "server.json"));
    expect(hookErrorLog(env)).toBe(join(state, "hook-errors.log"));
  });

  it("puts the history database in the state dir, with process.env as the default", () => {
    const { env, state } = makeEnv();
    expect(historyPath(env)).toBe(join(state, "history.db"));
    expect(historyPath().endsWith("history.db")).toBe(true);
  });

  it("falls back to ~/.agents paths under HOME", () => {
    const { home } = makeEnv();
    const bare: NodeJS.ProcessEnv = { HOME: home };
    expect(stateDir(bare)).toBe(join(home, ".agents/radar"));
    expect(claudeConfigDir(bare)).toBe(join(home, ".claude"));
    expect(zaiStateDir(bare)).toBe(join(home, ".agents/zai"));
  });

  it("honours CLAUDE_CONFIG_DIR and ZAI_STATE_DIR overrides", () => {
    const { env, home } = makeEnv();
    expect(claudeConfigDir(env)).toBe(join(home, "claude"));
    expect(zaiStateDir(env)).toBe(join(home, "zai"));
  });

  it("resolves the plugin public dir, with an env override winning", () => {
    const { env, home } = makeEnv();
    const fallback = publicDir(env);
    expect(fallback).toContain("plugin/public");
    expect(publicDir({ ...env, RADAR_PUBLIC_DIR: join(home, "pub") })).toBe(join(home, "pub"));
  });

  it("finds public/ beside dist/ in an installed copy, where only plugin/ is copied", () => {
    const { env, home } = makeEnv();
    const installed = join(home, "cache", "radar", "0.0.1");
    writeText(join(installed, "public", "index.html"), "<!doctype html>");
    const bundle = pathToFileURL(join(installed, "dist", "radar.js")).href;
    expect(publicDir(env, bundle)).toBe(join(installed, "public") + sep);
  });
});

describe("ensureStateDirs", () => {
  it("creates the state dir and the spool dir, and is idempotent", () => {
    const { env, state } = makeEnv();
    expect(ensureStateDirs(env)).toBe(true);
    expect(existsSync(state)).toBe(true);
    expect(existsSync(join(state, "spool"))).toBe(true);
    expect(ensureStateDirs(env)).toBe(true);
  });

  it("marks a state dir it created, or one holding only its own files, and nothing else", () => {
    const { env, home, state } = makeEnv();
    expect(ensureStateDirs(env)).toBe(true);
    expect(existsSync(stateMarkerPath(env))).toBe(true);

    const legacy = { ...env, RADAR_HOME: join(home, "legacy") }; // unmarked: ours by contents
    writeText(join(home, "legacy", "server.json"), "{}");
    writeText(join(home, "legacy", "spool", "2026-01-01.jsonl"), "{}\n");
    expect(ensureStateDirs(legacy)).toBe(true);
    expect(existsSync(stateMarkerPath(legacy))).toBe(true);

    const foreign = { ...env, RADAR_HOME: home }; // $HOME itself: holds state/, legacy/ and more
    expect(ensureStateDirs(foreign)).toBe(true);
    expect(existsSync(stateMarkerPath(foreign))).toBe(false);
    expect(existsSync(state)).toBe(true);
  });

  it("returns false instead of throwing when the location cannot be made", () => {
    // a file where a directory is wanted makes mkdir fail: the hook must survive that
    const { env, home } = makeEnv();
    writeText(join(home, "blocker"), "file");
    expect(ensureStateDirs({ ...env, RADAR_HOME: join(home, "blocker") })).toBe(false);
  });
});

describe("fileExists", () => {
  it("mirrors the filesystem", () => {
    const { home } = makeEnv();
    const path = writeText(join(home, "a.txt"), "x");
    expect(fileExists(path)).toBe(true);
    expect(fileExists(join(home, "missing.txt"))).toBe(false);
  });
});
