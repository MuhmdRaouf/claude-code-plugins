import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFsEngineConfig } from "../../src/adapters/fs-engine-config.ts";
import { engineEnabled, withEngine } from "../../src/domain/engine.ts";
import { stateLayout } from "../../src/domain/state-layout.ts";
import { tempDir } from "../support/tmp.ts";

const OMP = { watcher: "provider", version: "omp/18.6.3", path: "/usr/bin/omp" } as const;

describe("the engine config", () => {
  it("a plugin set up before engines existed has no file: claude only", () => {
    const root = tempDir();

    expect(createFsEngineConfig(root).read()).toEqual({ engines: {} });
    expect(engineEnabled(createFsEngineConfig(root).read(), "claude")).toBe(true);
    expect(engineEnabled(createFsEngineConfig(root).read(), "omp")).toBe(false);
  });

  it("round-trips, additive per engine, with the default engine kept", () => {
    const root = tempDir();
    createFsEngineConfig(root).write({ engines: { pi: { ...OMP, watcher: "sonnet" } }, defaultEngine: "pi" });
    createFsEngineConfig(root).write(withEngine(createFsEngineConfig(root).read(), "omp", OMP));

    expect(createFsEngineConfig(root).read()).toEqual({
      engines: { pi: { ...OMP, watcher: "sonnet" }, omp: OMP },
      defaultEngine: "pi",
    });
    expect(engineEnabled(createFsEngineConfig(root).read(), "omp")).toBe(true);
  });

  it("an unreadable or foreign file reads as claude only", () => {
    const root = tempDir();
    writeFileSync(stateLayout(root).engines, JSON.stringify({ engines: { omp: { watcher: "opus" } } }));

    expect(createFsEngineConfig(root).read()).toEqual({ engines: {} });
    writeFileSync(stateLayout(root).engines, "[");
    expect(createFsEngineConfig(root).read()).toEqual({ engines: {} });
  });
});
