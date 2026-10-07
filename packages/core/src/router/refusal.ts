// What a provider route answers when the provider refuses the key, the account has run dry, or the user's budget in
// the Observatory dashboard is used up. Claude Code reads a 401
// or 403 as its own Anthropic login failing ("run /login"), and retries a 429 or a 5xx with backoff for minutes, so on
// a provider route neither may reach it as it came: a refused or missing key and an empty balance both become a 400
// that is not retried (`x-should-retry: false`) and says what to run or where to top up. `claude-*` and peer routes
// never come through here. No upstream text is copied into the answer, so nothing the provider echoes (a key
// included) can leak through it.

import type { Provider } from "../domain/provider.ts";
import { outOfBalance } from "../domain/provider-balance.ts";
import type { Replacement } from "./upstream.ts";

/** Why a provider answer is rewritten: the key was refused (or there is none), or the account has no balance. */
type Refusal = "key" | "balance";

/** The upstream answers worth reading before they are sent: every error. A success streams through untouched. */
export function mayRefuse(status: number): boolean {
  return status >= 400;
}

/** Why the provider's answer is a refusal, or undefined for any other answer (sent as it came). */
export function refusalOf(status: number, body: Buffer): Refusal | undefined {
  if (status < 400) return undefined;
  if (outOfBalance(status, parseBody(body))) return "balance";
  return status === 401 || status === 403 ? "key" : undefined;
}

function parseBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The status every refusal is answered with: a 400 is neither a login failure nor retried. */
const REFUSAL_STATUS = 400;

/** The message a refusal carries; `why` says what the router saw (an upstream status, or no key). */
function refusalMessage(
  provider: Pick<Provider, "display" | "slash" | "billingUrl">,
  refusal: Refusal,
  why: string,
): string {
  return refusal === "key"
    ? `${provider.display} key refused or missing: run ${provider.slash}setup (${why}). Claude models are not affected.`
    : `${provider.display} says this key has no balance or quota left (${why}): top up at ${provider.billingUrl}, then retry. Claude models are not affected.`;
}

/** The Anthropic-shaped, non-retryable answer for a refusal. */
export function refusalAnswer(
  provider: Pick<Provider, "display" | "slash" | "billingUrl">,
  refusal: Refusal,
  why: string,
): Replacement {
  return refused(refusalMessage(provider, refusal, why));
}

/** The answer for a provider request while the observatory's budget for it is stopped: the refusal's shape. */
export function budgetAnswer(message: string): Replacement {
  return refused(message);
}

function refused(message: string): Replacement {
  return {
    status: REFUSAL_STATUS,
    headers: { "content-type": "application/json", "x-should-retry": "false" },
    body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
  };
}
