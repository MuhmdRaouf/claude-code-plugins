// The five provider plugins' routers as any of them sees the others: where each listens, and what `setup` may do with
// Claude Code's ANTHROPIC_BASE_URL given where it points now. Pure: no I/O, so the settings merge, the router and the
// setup report share one answer.

/** The port of every plugin's router, so one plugin can tell another's from its own. */
export const PLUGIN_ROUTERS: ReadonlyMap<number, string> = new Map([
  [18787, "zai"],
  [18788, "kimi"],
  [18789, "deepseek"],
  [18790, "minimax"],
  [18791, "qwen"],
]);

/** A URL's port, or -1 when it has none or does not parse. */
export function portOf(url: string): number {
  try {
    return Number(new URL(url).port) || -1;
  } catch {
    return -1;
  }
}

/** Only this machine may be an http upstream: tests point it at loopback fakes, and everything else must be https. */
export function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
}

/** True when the URL is one of the five plugin routers (loopback host, known port) — the only base URL `setup` may
 *  replace. Anything else is the user's own proxy. */
export function isPluginRouterUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isLoopback(parsed.hostname) && PLUGIN_ROUTERS.has(portOf(parsed.href));
  } catch {
    return false;
  }
}

/** What happens to `env.ANTHROPIC_BASE_URL`. */
export type BaseUrlPlan =
  | { readonly kind: "set"; readonly url: string; readonly report: string }
  | { readonly kind: "remove"; readonly report: string }
  | { readonly kind: "keep"; readonly report?: string };

/** The report line of a plan that changed nothing: a note, not a change (the hook stays silent about it). */
export const KEPT_PREFIX = "kept ";

/** apply: point it at this plugin's router when unset or at a plugin router that is down; a live plugin router keeps
 *  it (every plugin's router serves every plugin's models, so there is nothing to win by moving it, and five hooks
 *  moving it back and forth is what this prevents); anything else is the user's own proxy, kept and reported. */
export function planBaseUrl(
  current: string | undefined,
  routerUrl: string,
  livePluginUrls: readonly string[] = [],
): BaseUrlPlan {
  if (current === undefined)
    return { kind: "set", url: routerUrl, report: `pointed ANTHROPIC_BASE_URL at ${routerUrl}` };
  if (current === routerUrl) return { kind: "keep" };
  const other = isPluginRouterUrl(current) ? PLUGIN_ROUTERS.get(portOf(current)) : undefined;
  if (other !== undefined && livePluginUrls.includes(current)) return { kind: "keep" };
  if (other !== undefined)
    return {
      kind: "set",
      url: routerUrl,
      report: `moved ANTHROPIC_BASE_URL from the ${other} plugin's router (${current}, not running) to ${routerUrl}`,
    };
  return { kind: "keep", report: `${KEPT_PREFIX}ANTHROPIC_BASE_URL (${current}): your own proxy` };
}

/** clear: take it out when it points at this plugin's router, repointing it at another live one when there is any. */
export function planBaseUrlRemoval(
  current: string | undefined,
  routerUrl: string,
  others: readonly string[],
): BaseUrlPlan {
  if (current !== routerUrl) return { kind: "keep" };
  const [first] = others;
  return first === undefined
    ? { kind: "remove", report: `removed ANTHROPIC_BASE_URL (${routerUrl})` }
    : { kind: "set", url: first, report: `pointed ANTHROPIC_BASE_URL at another plugin's router (${first})` };
}
