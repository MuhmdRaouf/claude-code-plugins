// "This account has no balance or quota left": each provider says it its own way, on its own status. The router turns
// such an answer into one Claude Code does not retry, and a job that ran into one is not retried either: no retry can
// succeed until the user tops up.

/** The provider's own error codes for an account out of balance or quota, as each documents them:
 *  - Z.ai: 1113 "Insufficient balance or no resource package" (HTTP 429), 1316/1317 usage cap reached with
 *    "Insufficient balance for extra usage" (HTTP 429): https://docs.z.ai/api-reference/api-code
 *  - Moonshot: error.type `exceeded_current_quota_error` (HTTP 429, "Account balance is insufficient or the account has
 *    been disabled"): https://platform.kimi.ai/docs/api/errors
 *  - DeepSeek: HTTP 402 "Insufficient Balance" (matched by status below):
 *    https://api-docs.deepseek.com/quick_start/error_codes
 *  - MiniMax: base_resp.status_code 1008 "insufficient balance": https://platform.minimax.io/docs/api-reference/errorcode
 *  - Alibaba Model Studio (DashScope): `Arrearage` (HTTP 400, "Access denied, please make sure your account is in good
 *    standing") and `isv.OUT_OF_SERVICE`: https://www.alibabacloud.com/help/en/model-studio/error-code */
const BALANCE_CODES: ReadonlySet<string> = new Set([
  "1113",
  "1316",
  "1317",
  "exceeded_current_quota_error",
  "1008",
  "Arrearage",
  "isv.OUT_OF_SERVICE",
]);

/** The documented wording of those same errors, for a provider that sends the message without its code. */
const BALANCE_WORDING = /insufficient balance|account is in good standing|余额不足|欠费/i;

/** Whether an error answer (its status and its parsed JSON body, when it has one) says the account is out of balance
 *  or quota: DeepSeek's 402, or one of the codes or wordings above in the places each provider puts them. */
export function outOfBalance(status: number, body: unknown): boolean {
  if (status === 402) return true;
  const top = record(body);
  if (top === undefined) return false;
  const error = record(top.error);
  const base = record(top.base_resp);
  const codes = [error?.code, error?.type, top.code, top.type, base?.status_code];
  if (
    codes.some(
      (code) => (typeof code === "string" || typeof code === "number") && BALANCE_CODES.has(String(code)),
    )
  )
    return true;
  const messages = [error?.message, top.message, base?.status_msg];
  return messages.some((message) => typeof message === "string" && BALANCE_WORDING.test(message));
}

/** A code in a JSON fragment of free text (a worker's "API Error: 429 {…}" line): `"code":"1113"`, `"type":
 *  "exceeded_current_quota_error"`, `"status_code":1008`, `"code":"Arrearage"`. */
const CODE_IN_TEXT = /"(?:code|type|status_code)"\s*:\s*"?([A-Za-z0-9_.]+)"?/g;

/** The same verdict from an error's text alone, as a worker reports it: DeepSeek's 402, a known code in the JSON the
 *  text carries, or the documented wording. */
export function outOfBalanceText(status: number | undefined, text: string): boolean {
  if (status === 402) return true;
  for (const match of text.matchAll(CODE_IN_TEXT)) if (BALANCE_CODES.has(match[1] as string)) return true;
  return BALANCE_WORDING.test(text);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
