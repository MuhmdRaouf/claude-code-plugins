/**
 * Redaction and truncation: nothing the hook or the server writes may carry a secret. Rules (in order):
 *   1. any object key matching SECRET_KEY has its whole value replaced, at any depth, in objects and arrays;
 *   2. inside strings, `Bearer <token>` headers and sk-…-style API keys are masked;
 *   3. when a *.env file path appears anywhere in a tool input object, that object's content-bearing keys are
 *      replaced (the transcript stays the source of truth for what was really read or written);
 *   4. every string is truncated to the per-field budget (2 KB by default) with a note of what was cut.
 * Pure and total: any input yields output; unknown shapes pass through the same rules.
 */

const SECRET_KEY = /key|token|secret|password|authorization|cookie/i;
const BEARIER = /\bBearer\s+[A-Za-z0-9._-]+/g;
const SK_KEY = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g;
const REDACTED = "[redacted]";
/** .env, .env.local, prod.env — a basename that is or ends in .env, with an optional dot-suffix. */
const ENV_FILE_PATH = /(^|\/)(\.env(\.[^/]+)?|[^/]+\.env)$/;

/** Keys that carry file contents next to a path (Write/Edit inputs, Bash commands that cat an env file). */
const CONTENT_KEYS = /^(content|contents|command|text|body|new_str|newString|edits|value)$/;

export const FIELD_LIMIT = 2048;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export function isEnvFilePath(value: string): boolean {
  return ENV_FILE_PATH.test(value.trim());
}

function maskString(text: string): string {
  return text.replace(BEARIER, "Bearer [redacted]").replace(SK_KEY, REDACTED);
}

export function truncate(text: string, limit = FIELD_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rule 3: an object that mentions an env file anywhere loses its content-bearing values. */
function mentionsEnvFile(record: Record<string, unknown>): boolean {
  return Object.values(record).some((value) => typeof value === "string" && isEnvFilePath(value));
}

function scrubObject(record: Record<string, unknown>, limit: number): Record<string, unknown> {
  const envAdjacent = mentionsEnvFile(record);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isSecretKey(key)) out[key] = REDACTED;
    else if (envAdjacent && CONTENT_KEYS.test(key)) out[key] = REDACTED;
    else out[key] = scrub(value, limit);
  }
  return out;
}

/** Redact and truncate a value recursively; scalars other than strings pass through untouched. */
export function scrub(value: unknown, limit = FIELD_LIMIT): unknown {
  if (typeof value === "string") return truncate(maskString(value), limit);
  if (Array.isArray(value)) return value.map((item) => scrub(item, limit));
  if (isPlainObject(value)) return scrubObject(value, limit);
  return value;
}

/** A string field only (prompt text and the like): mask then truncate. */
export function scrubText(value: unknown, limit = FIELD_LIMIT): string | undefined {
  if (typeof value !== "string") return undefined;
  return truncate(maskString(value), limit);
}
