// The engine config file (`engines.json` in the state root, beside the `setup-done` mark, so plugin updates cannot lose
// it). A missing or unreadable file is the config of a plugin set up before engines existed: claude only.
import { z } from "zod";
import { ENGINE_TOOLS, ENGINES, type EngineConfig } from "../domain/engine.ts";
import { stateLayout } from "../domain/state-layout.ts";
import type { EngineConfigStore } from "../ports/index.ts";
import { readJsonFile, writeFileAtomicSync } from "./fs-files.ts";

const Setting = z.object({ watcher: z.enum(["provider", "sonnet"]), version: z.string(), path: z.string() });

const ConfigFile = z.object({
  engines: z.partialRecord(z.enum(ENGINE_TOOLS), Setting).default({}),
  defaultEngine: z.enum(ENGINES).optional(),
});

export function createFsEngineConfig(stateRoot: string): EngineConfigStore {
  const file = stateLayout(stateRoot).engines;
  return {
    read() {
      const parsed = readJsonFile(file, ConfigFile);
      if (parsed === undefined) return { engines: {} };
      const { engines, defaultEngine } = parsed;
      return defaultEngine === undefined ? { engines } : { engines, defaultEngine };
    },
    write(config: EngineConfig) {
      writeFileAtomicSync(file, `${JSON.stringify(config, null, 2)}\n`, { mkdir: true });
    },
  };
}
