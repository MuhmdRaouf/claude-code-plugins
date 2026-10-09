/**
 * The environment a delegation tool starts with: the user's own, as if they had run the tool themselves, so the tool
 * finds its own login, config and keys. Only what this session added on top is withheld — the plugin's own provider
 * variables (its key and every `<PREFIX>_` knob, named by `withheld`) and Claude Code's routing and session variables,
 * which can point at a plugin router. The plugin never adds a provider, model, endpoint or key of its own.
 */
import { withoutReserved } from "../../env.ts";

/** Claude Code's routing (its settings env can point ANTHROPIC_BASE_URL at a plugin router) and session variables. */
const CLAUDE_ROUTING = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
]);

/** Whether a name belongs to the Claude Code session the orchestrator runs in rather than to the user's shell. */
export function isClaudeSessionVar(name: string): boolean {
  return (
    CLAUDE_ROUTING.has(name) ||
    name.startsWith("ANTHROPIC_DEFAULT_") ||
    name.startsWith("CLAUDE_") ||
    name === "CLAUDECODE"
  );
}

/** The parent's environment minus the withheld names and Claude's session; then the brief's `env`, minus the names a
 *  brief may not set (`reserved`: the tool's own variables and any key), since brief names are orchestrator-written. */
export function toolEnv(
  parent: Readonly<Record<string, string | undefined>>,
  passEnv: Readonly<Record<string, string>>,
  withheld: (name: string) => boolean,
  reserved: (name: string) => boolean,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || withheld(name) || isClaudeSessionVar(name)) continue;
    env[name] = value;
  }
  const blocked = (name: string): boolean => withheld(name) || isClaudeSessionVar(name) || reserved(name);
  return { ...env, ...withoutReserved(passEnv, blocked) };
}
