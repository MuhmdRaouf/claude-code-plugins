/** The environment workers and gates start from: a few basics from the parent, never its credentials. */

/** Variables copied from the parent environment. Gates (shell-gates.ts) build their env from the same list, which must
 *  stay free of CLAUDE_* names; a worker that wants the orchestrator's CLAUDE* settings copies them itself (the claude
 *  worker's pickClaudeSettings). Everything else (the orchestrator's ANTHROPIC_*, plugin variables, tokens) is
 *  dropped. */
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "TMPDIR",
  "USER",
  "LOGNAME",
] as const;

/** The ENV_ALLOWLIST names `parent` sets. */
export function pickAllowlisted(
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** `passEnv` without the names a worker reserves for its own routing and credentials. Brief `env` names are
 *  orchestrator-written, so a typo must not be able to send credentials elsewhere or re-route the worker. */
export function withoutReserved(
  passEnv: Readonly<Record<string, string>>,
  reserved: (name: string) => boolean,
): Record<string, string> {
  return Object.fromEntries(Object.entries(passEnv).filter(([name]) => !reserved(name)));
}
