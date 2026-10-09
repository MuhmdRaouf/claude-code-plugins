import { basename } from "node:path";
import type { Provider } from "../domain/provider.ts";
import { agentsStateDir, migrateStateDir } from "./state-migrate.ts";

/** Where one provider keeps its state: an explicit env var, its own Claude Code data dir, else ~/.agents. */
export interface StateRootRule {
  /** The variable that names the root outright, e.g. ZAI_STATE_DIR. */
  readonly envVar: string;
  /** $CLAUDE_PLUGIN_DATA counts only when its basename starts with this (the provider's catalogue entry). */
  readonly dataPrefix: string;
  /** The dir name under ~/.agents (an older XDG one moves over there). */
  readonly xdgName: string;
}

/**
 * State root: $<envVar>, else $CLAUDE_PLUGIN_DATA when it is the provider's own data dir
 * (`…/data/<entry>-<marketplace>`, named after the catalogue entry), else ~/.agents/<xdgName>, with an old
 * $XDG_STATE_HOME/<xdgName> or ~/.local/state/<xdgName> moved over once. Claude Code leaks one plugin's
 * CLAUDE_PLUGIN_DATA into every Bash tool call, so a foreign one must never be used: the jobs would land in another
 * plugin's data dir.
 */
export function resolveStateRoot(
  env: Readonly<Record<string, string | undefined>>,
  rule: StateRootRule,
  log: (line: string) => void = console.error,
): string {
  const explicit = env[rule.envVar];
  if (explicit) return explicit;
  if (env.CLAUDE_PLUGIN_DATA && basename(env.CLAUDE_PLUGIN_DATA).startsWith(rule.dataPrefix))
    return env.CLAUDE_PLUGIN_DATA;
  migrateStateDir(rule.xdgName, env, log);
  return agentsStateDir(env, rule.xdgName);
}

/** Every provider's rule, derived from its own names: $<envPrefix>_STATE_DIR, its `<name>-…` data dir, `<name>`. */
export function stateRootRule(provider: Pick<Provider, "name" | "envPrefix">): StateRootRule {
  return {
    envVar: `${provider.envPrefix}_STATE_DIR`,
    dataPrefix: `${provider.name}-`,
    xdgName: provider.name,
  };
}

/** A provider's state root (see resolveStateRoot). */
export function stateRoot(provider: Provider, env: Readonly<Record<string, string | undefined>>): string {
  return resolveStateRoot(env, stateRootRule(provider));
}
