// The Claude Code settings merge: `setup` puts the provider's models in `/model` and points
// Claude Code at the plugin's router, owning exactly the entries whose `model` is in its catalog so `setup --remove`
// (and the router's own uninstall cleanup) can take those back out. Everything else in the file survives. Every write
// is careful: only a missing file counts as empty (any other read error writes nothing), the first write ever keeps a
// `settings.json.<name>-backup`, the result must survive a JSON round trip, the file's mode and a symlink are kept,
// writers on this machine take turns through a lock, and a file that changed on disk while it was being edited is
// re-read and redone once, else left alone.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BaseUrlPlan } from "../domain/plugin-routers.ts";
import { isPluginRouterUrl, planBaseUrl, planBaseUrlRemoval } from "../domain/plugin-routers.ts";
import type { Provider } from "../domain/provider.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { errnoCode, errorMessage } from "./fs-errors.ts";
import { writeFileAtomicSync } from "./fs-files.ts";
import { waitLock } from "./fs-lock.ts";
import { isAlive } from "./process/group.ts";

/** Claude Code's config dir: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  return env.CLAUDE_CONFIG_DIR === "" || env.CLAUDE_CONFIG_DIR === undefined
    ? join(env.HOME ?? homedir(), ".claude")
    : env.CLAUDE_CONFIG_DIR;
}

/** The settings file Claude Code reads, in its config dir. */
export function claudeSettingsPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(claudeConfigDir(env), "settings.json");
}

/** The `model` field of a `/model` options entry, or undefined for anything not shaped like one. */
function entryModel(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const model = (entry as Record<string, unknown>).model;
  return typeof model === "string" ? model : undefined;
}

/** What one `applyProviderSettings` changed, for the uninstall ledger: enough to put back exactly what was there. */
export interface SettingsDelta {
  /** The base URL before, when this run changed it: a string, or null when there was none. */
  readonly baseUrlBefore?: string | null;
  /** The catalog ids whose `/model` entry this run added. */
  readonly optionsAdded: readonly string[];
  /** The ids this run appended to an existing `availableModels`. */
  readonly availableAppended: readonly string[];
  /** Containers this run created, removed again when they end up empty. */
  readonly createdModelPicker: boolean;
  readonly createdOptions: boolean;
  readonly createdEnv: boolean;
}

/** Merges one `modelPicker.options` entry per catalog model, appends the ids to `availableModels` only when that list
 *  already exists, and sets `env.ANTHROPIC_BASE_URL` per the plan above. Idempotent: a second run changes nothing.
 *  Returns the report lines, or an error and writes nothing when the file is unparsable or a touched key has the
 *  wrong type. `record` gets what changed (only when something did). */
export async function applyProviderSettings(
  path: string,
  provider: Provider,
  routerUrl: string,
  options: {
    readonly livePluginUrls?: readonly string[];
    readonly record?: (delta: SettingsDelta) => void;
  } = {},
): Promise<Result<readonly string[], string>> {
  return editSettings(path, provider.name, (root) => {
    const createdModelPicker = root.modelPicker === undefined;
    const picker = ensureObject(root, "modelPicker", path);
    if (!picker.ok) return picker;
    const createdOptions = picker.value.options === undefined;
    const options_ = ensureArray(picker.value, "options", `${path}: modelPicker.options`);
    if (!options_.ok) return options_;
    const before = new Set(options_.value.map(entryModel));
    const available = appendAvailableModels(root, provider, path);
    if (!available.ok) return available;
    const createdEnv = root.env === undefined;
    const baseUrlBefore = currentBaseUrl(root, path);
    const plan = planBaseUrl(baseUrlBefore, routerUrl, options.livePluginUrls ?? []);
    const lines = [
      ...mergeModelOptions(options_.value, provider),
      ...available.value.lines,
      ...applyBaseUrl(root, plan, path),
    ];
    options.record?.({
      ...(plan.kind === "set" ? { baseUrlBefore: baseUrlBefore ?? null } : {}),
      optionsAdded: [provider.catalog.main.id, provider.catalog.flash.id].filter((id) => !before.has(id)),
      availableAppended: available.value.appended,
      createdModelPicker,
      createdOptions,
      createdEnv: createdEnv && plan.kind === "set",
    });
    return ok(lines);
  });
}

/** Removes exactly the entries whose `model` is one of this provider's catalog ids (an emptied list stays an empty
 *  array) and clears `env.ANTHROPIC_BASE_URL` per the plan above. */
export async function removeProviderSettings(
  path: string,
  provider: Provider,
  routerUrl: string,
  othersRegistered: readonly string[],
): Promise<Result<readonly string[], string>> {
  return editSettings(path, provider.name, (root) => {
    const ids = [provider.catalog.main.id, provider.catalog.flash.id];
    const entries = removeModelEntries(root, ids, path);
    if (!entries.ok) return entries;
    const available = removeAvailableModels(root, ids, path);
    if (!available.ok) return available;
    return ok([
      ...entries.value,
      ...available.value,
      ...applyBaseUrl(
        root,
        planBaseUrlRemoval(currentBaseUrl(root, path), routerUrl, othersRegistered),
        path,
      ),
    ]);
  });
}

/** The hook's half-measure: clear or repoint `env.ANTHROPIC_BASE_URL` only, leaving every model entry alone. */
export async function clearBaseUrl(
  path: string,
  routerUrl: string,
  othersRegistered: readonly string[],
  name = "provider-router",
): Promise<Result<readonly string[], string>> {
  return editSettings(path, name, (root) =>
    ok(applyBaseUrl(root, planBaseUrlRemoval(currentBaseUrl(root, path), routerUrl, othersRegistered), path)),
  );
}

/** The current `env.ANTHROPIC_BASE_URL`, or undefined when unset or the file cannot be read. */
export function readBaseUrl(path: string): string | undefined {
  try {
    const root: unknown = JSON.parse(readFileSync(path, "utf8"));
    const env = (root as Record<string, unknown> | null)?.env;
    const url =
      typeof env === "object" && env !== null
        ? (env as Record<string, unknown>).ANTHROPIC_BASE_URL
        : undefined;
    return typeof url === "string" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** What setup changed, as the ledger recorded it (see SettingsDelta, merged across runs). */
export interface SettingsUndo {
  readonly baseUrlBefore?: string | null;
  readonly optionsAdded: readonly string[];
  readonly availableAppended: readonly string[];
  readonly createdModelPicker: boolean;
  readonly createdOptions: boolean;
  readonly createdEnv: boolean;
}

/** The uninstall's settings step: takes out the `/model` entries and `availableModels` ids setup added (an entry the
 *  user removed or changed meanwhile is theirs), removes the containers setup created when they end up empty, and
 *  puts the base URL back only if it still points at this router: the ledger's previous value (unless that is a plugin
 *  router that is not running), else another live plugin router, else none. When the result equals the backup taken
 *  before the first write ever, the backup's own bytes are restored. */
export async function undoProviderSettings(
  path: string,
  name: string,
  undo: SettingsUndo,
  routerUrl: string,
  livePluginUrls: readonly string[],
): Promise<Result<readonly string[], string>> {
  return editSettings(
    path,
    name,
    (root) =>
      ok([
        ...undoPicker(root, undo),
        ...undoAvailable(root, undo),
        ...undoBaseUrl(root, undo, routerUrl, livePluginUrls, path),
      ]),
    { restoreBackup: true },
  );
}

/** Takes setup's `/model` entries out, and the containers it created once they are empty. */
function undoPicker(root: Record<string, unknown>, undo: SettingsUndo): readonly string[] {
  const picker = root.modelPicker;
  if (typeof picker !== "object" || picker === null || Array.isArray(picker)) return [];
  const record = picker as Record<string, unknown>;
  const lines: string[] = [];
  if (Array.isArray(record.options)) {
    const kept = record.options.filter((entry) => !undo.optionsAdded.includes(entryModel(entry) ?? "\0"));
    if (kept.length !== record.options.length)
      lines.push(`took ${undo.optionsAdded.join(" and ")} out of /model`);
    record.options = kept;
    if (undo.createdOptions && kept.length === 0) delete record.options;
  }
  if (undo.createdModelPicker && Object.keys(record).length === 0) delete root.modelPicker;
  return lines;
}

/** Takes the ids setup appended out of `availableModels`. */
function undoAvailable(root: Record<string, unknown>, undo: SettingsUndo): readonly string[] {
  if (!Array.isArray(root.availableModels) || undo.availableAppended.length === 0) return [];
  const kept = root.availableModels.filter((id) => !undo.availableAppended.includes(id));
  const changed = kept.length !== root.availableModels.length;
  root.availableModels = kept;
  return changed ? ["took the appended ids out of availableModels"] : [];
}

/** Puts the base URL back, only while it still points at this router (see undoProviderSettings). */
function undoBaseUrl(
  root: Record<string, unknown>,
  undo: SettingsUndo,
  routerUrl: string,
  livePluginUrls: readonly string[],
  path: string,
): readonly string[] {
  if (currentBaseUrl(root, path) !== routerUrl) return [];
  const previous = undo.baseUrlBefore ?? undefined;
  const restore =
    previous !== undefined && (!isPluginRouterUrl(previous) || livePluginUrls.includes(previous))
      ? previous
      : livePluginUrls.find((url) => url !== routerUrl);
  const env = root.env as Record<string, unknown>;
  if (restore !== undefined) {
    env.ANTHROPIC_BASE_URL = restore;
    return [`set ANTHROPIC_BASE_URL back to ${restore}`];
  }
  delete env.ANTHROPIC_BASE_URL;
  if (undo.createdEnv && Object.keys(env).length === 0) delete root.env;
  return [`removed ANTHROPIC_BASE_URL (${routerUrl})`];
}

// ── the merge's moving parts ─────────────────────────────────────────────────────────────────────────────────────────

/** The key as a mutable object, an empty one created when missing (objectAt then cannot miss). */
function ensureObject(
  root: Record<string, unknown>,
  key: string,
  path: string,
): Result<Record<string, unknown>, string> {
  if (root[key] === undefined) root[key] = {};
  return objectAt(root, key, path) as Result<Record<string, unknown>, string>;
}

/** The key as a mutable array, an empty one created when missing (arrayAt then cannot miss). */
function ensureArray(root: Record<string, unknown>, key: string, path: string): Result<unknown[], string> {
  if (root[key] === undefined) root[key] = [];
  return arrayAt(root, key, path) as Result<unknown[], string>;
}

/** The key as an object when it is one, undefined when it is missing; an error, never a write, when it is neither. */
function objectAt(
  root: Record<string, unknown>,
  key: string,
  path: string,
): Result<Record<string, unknown> | undefined, string> {
  const value = root[key];
  if (value === undefined) return ok(undefined);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return err(`${path}: ${key} must be an object; nothing changed`);
  return ok(value as Record<string, unknown>);
}

function arrayAt(
  root: Record<string, unknown>,
  key: string,
  path: string,
): Result<unknown[] | undefined, string> {
  const value = root[key];
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value)) return err(`${path}: ${key} must be an array; nothing changed`);
  return ok(value);
}

function appendAvailableModels(
  root: Record<string, unknown>,
  provider: Provider,
  path: string,
): Result<{ readonly lines: readonly string[]; readonly appended: readonly string[] }, string> {
  const available = root.availableModels;
  if (available === undefined) return ok({ lines: [], appended: [] });
  if (!Array.isArray(available)) return err(`${path}: availableModels must be an array; nothing changed`);
  const lines: string[] = [];
  const appended: string[] = [];
  for (const ref of [provider.catalog.main, provider.catalog.flash]) {
    if (!available.includes(ref.id)) {
      available.push(ref.id);
      appended.push(ref.id);
      lines.push(`added ${ref.id} to availableModels`);
    }
  }
  return ok({ lines, appended });
}

/** Adds (or relabels) one `modelPicker.options` entry per catalog model; returns what changed. */
function mergeModelOptions(options: unknown[], provider: Provider): readonly string[] {
  const changes: string[] = [];
  for (const ref of [provider.catalog.main, provider.catalog.flash]) {
    const existing = options.find((entry) => entryModel(entry) === ref.id);
    if (existing === undefined) {
      options.push({ model: ref.id, label: ref.label });
      changes.push(`added ${ref.label} (${ref.id}) to /model`);
    } else if ((existing as Record<string, unknown>).label !== ref.label) {
      (existing as Record<string, unknown>).label = ref.label;
      changes.push(`updated the ${ref.label} (${ref.id}) label in /model`);
    }
  }
  return changes;
}

/** Takes the ids' entries out of `modelPicker.options` (an emptied list stays an empty array). */
function removeModelEntries(
  root: Record<string, unknown>,
  ids: readonly string[],
  path: string,
): Result<readonly string[], string> {
  const picker = objectAt(root, "modelPicker", path);
  if (!picker.ok) return picker;
  if (picker.value === undefined) return ok([]);
  const options = arrayAt(picker.value, "options", `${path}: modelPicker.options`);
  if (!options.ok) return options;
  if (!options.value?.some((entry) => ids.includes(entryModel(entry) ?? "\0"))) return ok([]);
  const kept = options.value.filter((entry) => !ids.includes(entryModel(entry) ?? "\0"));
  options.value.splice(0, options.value.length, ...kept);
  return ok([`took ${ids.join(" and ")} out of /model`]);
}

/** Takes the ids out of `availableModels` when that list exists at all. */
function removeAvailableModels(
  root: Record<string, unknown>,
  ids: readonly string[],
  path: string,
): Result<readonly string[], string> {
  const available = root.availableModels;
  if (available === undefined) return ok([]);
  if (!Array.isArray(available)) return err(`${path}: availableModels must be an array; nothing changed`);
  const kept = available.filter((id) => !ids.includes(id));
  if (kept.length === available.length) return ok([]);
  root.availableModels = kept;
  return ok([`took ${ids.join(" and ")} out of availableModels`]);
}

function currentBaseUrl(root: Record<string, unknown>, path: string): string | undefined {
  const env = root.env;
  if (env === undefined) return undefined;
  if (typeof env !== "object" || env === null || Array.isArray(env))
    throw new Error(`${path}: env must be an object; nothing changed`);
  const current = (env as Record<string, unknown>).ANTHROPIC_BASE_URL;
  if (current === undefined) return undefined;
  if (typeof current !== "string" || current === "")
    throw new Error(`${path}: env.ANTHROPIC_BASE_URL must be a string; nothing changed`);
  return current;
}

function applyBaseUrl(root: Record<string, unknown>, plan: BaseUrlPlan, path: string): readonly string[] {
  if (plan.kind === "keep") return plan.report === undefined ? [] : [plan.report];
  const env = plan.kind === "set" ? ensureObject(root, "env", path) : objectAt(root, "env", path);
  if (!env.ok || env.value === undefined) return [plan.report];
  if (plan.kind === "remove") {
    delete env.value.ANTHROPIC_BASE_URL;
    if (Object.keys(env.value).length === 0) delete root.env;
  } else env.value.ANTHROPIC_BASE_URL = plan.url;
  return [plan.report];
}

// ── the careful write ───────────────────────────────────────────────────────────────────────────────────────────────

/** The backup kept of the file as it was before this plugin first wrote it. */
export function settingsBackupPath(path: string, name: string): string {
  return `${path}.${name}-backup`;
}

/** The file as read: its text (`{}` for a missing file), its stat (undefined when missing), where writes go. */
interface Snapshot {
  readonly text: string;
  readonly stat: Stats | undefined;
  readonly target: string;
}

/** Reads the file; only a missing file counts as empty, any other read error is an error and nothing is written. A
 *  symlinked settings.json is read and written through its target, so the link stays a link. */
function snapshot(path: string): Result<Snapshot, string> {
  let target = path;
  try {
    target = realpathSync(path);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      return err(`${path}: cannot read (${errorMessage(error)}); nothing changed`);
  }
  try {
    const stat = statSync(target);
    return ok({ text: readFileSync(target, "utf8"), stat, target });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return ok({ text: "{}", stat: undefined, target });
    return err(`${path}: cannot read (${errorMessage(error)}); nothing changed`);
  }
}

function unchanged(target: string, before: Stats | undefined): boolean {
  try {
    const now = statSync(target);
    return before !== undefined && now.mtimeMs === before.mtimeMs && now.size === before.size;
  } catch (error) {
    return before === undefined && errnoCode(error) === "ENOENT";
  }
}

/** Writes atomically with the file's mode, renamed over the target only when the target is still what was read. */
function replace(snap: Snapshot, text: string): boolean {
  return writeFileAtomicSync(snap.target, text, {
    mode: snap.stat === undefined ? 0o600 : snap.stat.mode & 0o777,
    mkdir: true,
    commitIf: () => unchanged(snap.target, snap.stat),
  });
}

type Edit = (root: Record<string, unknown>) => Result<readonly string[], string>;

/** The file parsed into a settings object, or why it cannot be edited. */
function parseSettings(path: string, text: string): Result<Record<string, unknown>, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(`${path}: not valid JSON; nothing changed`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return err(`${path}: not a settings object; nothing changed`);
  return ok(parsed as Record<string, unknown>);
}

/** The edit applied, errors (thrown or returned) as values. */
function applyEdit(edit: Edit, root: Record<string, unknown>): Result<readonly string[], string> {
  try {
    return edit(root);
  } catch (error) {
    return err(errorMessage(error));
  }
}

/** The text to write, only when it survives a JSON round trip unchanged. */
function serialized(path: string, root: Record<string, unknown>): Result<string, string> {
  const text = `${JSON.stringify(root, null, 2)}\n`;
  const lost = err(`${path}: the edited settings did not survive a JSON round trip; nothing changed`);
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(root) ? ok(text) : lost;
  } catch {
    return lost;
  }
}

/** Copies the file to its backup the first time this plugin ever writes it. */
function backupOnce(snap: Snapshot, backup: string): void {
  if (snap.stat === undefined || existsSync(backup)) return;
  copyFileSync(snap.target, backup);
  chmodSync(backup, 0o600);
}

/** One read-edit-write pass; "changed" when the file moved under it before the rename. */
function editOnce(
  path: string,
  name: string,
  edit: Edit,
  restoreBackup: boolean,
): Result<readonly string[], string> | "changed" {
  const snap = snapshot(path);
  if (!snap.ok) return snap;
  const root = parseSettings(path, snap.value.text);
  if (!root.ok) return root;
  const before = JSON.stringify(root.value);
  const changes = applyEdit(edit, root.value);
  if (!changes.ok || JSON.stringify(root.value) === before) return changes;
  const text = serialized(path, root.value);
  if (!text.ok) return text;
  const backup = settingsBackupPath(path, name);
  backupOnce(snap.value, backup);
  const final = restoreBackup ? (backupBytesIfEqual(backup, root.value) ?? text.value) : text.value;
  return replace(snap.value, final) ? changes : "changed";
}

/** The backup's own text when its JSON equals the edited settings (an exact undo restores the exact bytes). */
function backupBytesIfEqual(backup: string, parsed: unknown): string | undefined {
  try {
    const text = readFileSync(backup, "utf8");
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(parsed) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Reads, applies one edit and writes the result back (see the header), under a lock all five plugins share. */
async function editSettings(
  path: string,
  name: string,
  edit: Edit,
  options: { readonly restoreBackup?: boolean } = {},
): Promise<Result<readonly string[], string>> {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    return err(`${path}: ${errorMessage(error)}; nothing changed`);
  }
  const lock = await waitLock(`${path}.provider-routers.lock`, process.pid, isAlive, 5000);
  if (!lock.ok) return err(`${path}: another plugin is editing it; nothing changed`);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = editOnce(path, name, edit, options.restoreBackup === true);
      if (result !== "changed") return result;
    }
    return err(`${path}: changed on disk while being edited; nothing changed`);
  } catch (error) {
    return err(`${path}: ${errorMessage(error)}; nothing changed`);
  } finally {
    await lock.value();
  }
}
