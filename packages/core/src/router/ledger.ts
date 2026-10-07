// The ledger (`<state>/ledger.json`, 0600, atomic): every change setup made outside the plugin, with what was there
// before, so the router (which outlives the plugin) can undo exactly those when the plugin is uninstalled or disabled.
// A disabled plugin's ledger moves to `ledger.disabled.json`; the SessionStart hook of a re-enabled plugin finds it
// and re-applies setup.
import { rmSync } from "node:fs";
import { z } from "zod";
import type { SettingsDelta, SettingsUndo } from "../adapters/claude-settings.ts";
import { readJsonFile, writeFileAtomicSync } from "../adapters/fs-files.ts";

export interface Ledger {
  readonly version: 1;
  readonly plugin: string;
  /** The router URL setup pointed Claude Code at. */
  readonly routerUrl: string;
  readonly settingsPath: string;
  readonly settings: SettingsUndo;
  /** Whether setup created the provider's keystore item (only then does cleanup delete it). */
  readonly keystore: { readonly created: boolean };
  /** The files setup put outside the plugin: the router copies under the state root. */
  readonly routerFiles: readonly string[];
  /** The legacy OS service setup retired, if any. */
  readonly legacyRemoved?: string;
  /** `${CLAUDE_PLUGIN_DATA}/installed`, deleted by Claude Code on uninstall. */
  readonly marker?: string;
  readonly stateRoot: string;
}

/** Only what reading the ledger back relies on is checked: a ledger an older version wrote still counts. */
const LedgerShape = z.looseObject({
  version: z.literal(1),
  plugin: z.string(),
  routerUrl: z.string(),
  settings: z.looseObject({}),
});

export function readLedger(path: string): Ledger | undefined {
  return readJsonFile(path, LedgerShape) as Ledger | undefined;
}

export function writeLedger(path: string, ledger: Ledger): void {
  writeFileAtomicSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

export function removeLedger(path: string): void {
  rmSync(path, { force: true });
}

const EMPTY: SettingsUndo = {
  optionsAdded: [],
  availableAppended: [],
  createdModelPicker: false,
  createdOptions: false,
  createdEnv: false,
};

const union = (a: readonly string[], b: readonly string[]): readonly string[] => [...new Set([...a, ...b])];

/** Folds one setup run's delta into what earlier runs recorded: the first known "before" wins, additions add up. */
export function mergeSettingsUndo(
  previous: SettingsUndo | undefined,
  delta: SettingsDelta | undefined,
): SettingsUndo {
  const base = previous ?? EMPTY;
  if (delta === undefined) return base;
  const baseUrlBefore = base.baseUrlBefore !== undefined ? base.baseUrlBefore : delta.baseUrlBefore;
  return {
    ...(baseUrlBefore === undefined ? {} : { baseUrlBefore }),
    optionsAdded: union(base.optionsAdded, delta.optionsAdded),
    availableAppended: union(base.availableAppended, delta.availableAppended),
    createdModelPicker: base.createdModelPicker || delta.createdModelPicker,
    createdOptions: base.createdOptions || delta.createdOptions,
    createdEnv: base.createdEnv || delta.createdEnv,
  };
}
