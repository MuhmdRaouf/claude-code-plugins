import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Provider } from "../domain/provider.ts";

/** Where one provider keeps its state: an explicit env var, its own Claude Code data dir, an XDG fallback. */
export interface StateRootRule {
  /** The variable that names the root outright, e.g. ZAI_STATE_DIR. */
  readonly envVar: string;
  /** $CLAUDE_PLUGIN_DATA counts only when its basename starts with this (the provider's catalogue entry). */
  readonly dataPrefix: string;
  /** The dir name under $XDG_STATE_HOME or ~/.local/state. */
  readonly xdgName: string;
}

/**
 * State root: $<envVar>, else $CLAUDE_PLUGIN_DATA when it is the provider's own data dir
 * (`…/data/<entry>-<marketplace>`, named after the catalogue entry), else $XDG_STATE_HOME/<xdgName> or
 * ~/.local/state/<xdgName>. Claude Code leaks one plugin's CLAUDE_PLUGIN_DATA into every Bash tool call, so a foreign
 * one must never be used: the jobs would land in another plugin's data dir.
 */
export function resolveStateRoot(
  env: Readonly<Record<string, string | undefined>>,
  rule: StateRootRule,
): string {
  const explicit = env[rule.envVar];
  if (explicit) return explicit;
  if (env.CLAUDE_PLUGIN_DATA && basename(env.CLAUDE_PLUGIN_DATA).startsWith(rule.dataPrefix))
    return env.CLAUDE_PLUGIN_DATA;
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, rule.xdgName);
  return join(env.HOME ?? homedir(), ".local", "state", rule.xdgName);
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
