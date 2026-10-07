// One minimal request with a candidate key: the provider's ping tier, one output token. Only the status matters; the
// key travels in the Authorization header and nowhere else, and no error text from the request is ever kept.
import type { Provider } from "../domain/provider.ts";
import type { KeyVerdict } from "../ports/keys.ts";

/** accepted: the provider answered 2xx. limited: 429 or 402 (rate limit or empty balance: the key itself is good).
 *  refused: 401 or 403. unknown: anything else (network, 5xx). */
const CHECK_TIMEOUT_MS = 20_000;

export async function checkKey(
  provider: Pick<Provider, "baseUrl" | "catalog" | "pingTier">,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyVerdict> {
  const url = `${provider.baseUrl.intl.replace(/\/+$/, "")}/v1/messages`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: provider.catalog[provider.pingTier].id,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) return "refused";
    if (response.status === 429 || response.status === 402) return "limited";
    return response.ok ? "accepted" : "unknown";
  } catch {
    return "unknown";
  }
}
