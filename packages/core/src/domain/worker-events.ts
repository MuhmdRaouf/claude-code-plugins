import type { Usage, WorkerOutcome } from "./job.ts";
import { outOfBalanceText } from "./provider-balance.ts";

/**
 * What every worker's stream comes down to: each adapter reads its own wire (Claude Code's stream-json, omp's RPC
 * frames) into these events, and the core folds them into progress and the attempt's outcome. A wire event the core
 * does not track is kept as `other`.
 */
export type WorkerEvent =
  | { readonly type: "init"; readonly sessionId: string; readonly model: string }
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "error"; readonly message: string; readonly status: number | null }
  | {
      readonly type: "api_retry";
      readonly attempt: number;
      readonly maxRetries: number;
      readonly status: number | null;
    }
  | { readonly type: "assistant_text"; readonly text: string }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_use"; readonly name: string; readonly summary: string }
  | { readonly type: "tool_result"; readonly isError: boolean }
  | {
      readonly type: "result";
      readonly isError: boolean;
      readonly text: string;
      readonly structuredOutput: unknown;
      readonly turns: number;
      readonly durationMs: number;
      readonly costUsd: number;
      readonly usage: Omit<Usage, "turns" | "costUsd" | "rateLimitRetries" | "durationMs" | "model">;
      /** HTTP status of the failed API call (`api_error_status`), null when absent. */
      readonly apiErrorStatus: number | null;
      /** The model a delegation tool reported running on, in its own naming; absent when it reports none. */
      readonly model?: string;
    }
  | { readonly type: "other"; readonly raw: string };

/** Z.ai answers its 1302 "rate limit reached" with HTTP 429; other retried statuses are not budget pressure. */
const RATE_LIMIT_STATUS = 429;

/** Live view rendered by `show --follow` and the board. */
export interface Progress {
  readonly sessionId?: string;
  readonly phase: "starting" | "thinking" | "tool" | "writing" | "rate_limited" | "done";
  readonly turns: number;
  readonly lastTool?: string;
  /** Last ~500 chars of assistant text (deltas accumulated, reset per message). */
  readonly lastText: string;
  readonly rateLimitRetries: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
}

export const INITIAL_PROGRESS: Progress = {
  phase: "starting",
  turns: 0,
  lastText: "",
  rateLimitRetries: 0,
  toolCalls: 0,
  toolErrors: 0,
};

const LAST_TEXT_CHARS = 500;

function lastChars(text: string): string {
  return text.slice(-LAST_TEXT_CHARS);
}

export function reduceProgress(progress: Progress, event: WorkerEvent): Progress {
  switch (event.type) {
    case "init":
      return { ...progress, sessionId: event.sessionId, phase: "thinking" };
    case "session":
      // An engine-keyed session: the id the engine assigned, replacing the caller's placeholder.
      return { ...progress, sessionId: event.sessionId };
    case "error":
      // The worker's own report of a failed call; the fold learns nothing until a result or exit says more.
      return progress;
    case "api_retry":
      return event.status === RATE_LIMIT_STATUS
        ? { ...progress, phase: "rate_limited", rateLimitRetries: progress.rateLimitRetries + 1 }
        : progress;
    case "text_delta": {
      // Deltas only accumulate within the message being written; the first delta after anything else starts afresh.
      const sofar = progress.phase === "writing" ? progress.lastText : "";
      return { ...progress, phase: "writing", lastText: lastChars(sofar + event.text) };
    }
    case "assistant_text":
      return { ...progress, phase: "thinking", lastText: lastChars(event.text) };
    case "tool_use":
      return {
        ...progress,
        phase: "tool",
        lastTool: event.summary === "" ? event.name : `${event.name} ${event.summary}`,
        toolCalls: progress.toolCalls + 1,
      };
    case "tool_result":
      return { ...progress, phase: "thinking", toolErrors: progress.toolErrors + (event.isError ? 1 : 0) };
    case "result":
      return { ...progress, phase: "done", turns: event.turns };
    case "other":
      return progress;
  }
}

export interface WorkerResult {
  readonly outcome: WorkerOutcome;
  readonly usage: Usage;
  readonly report: unknown;
  readonly sessionId?: string;
}

/** Claude Code renders API failures as "API Error: Request rejected (429) · …"; older versions carry the status only
 *  in that text, so it is the fallback when the result has no `api_error_status`. */
const HTTP_ERROR_STATUS = /\(([45]\d\d)\)/;

function apiError(result: ResultEvent): WorkerOutcome {
  const fromText = HTTP_ERROR_STATUS.exec(result.text)?.[1];
  const status = result.apiErrorStatus ?? (fromText === undefined ? undefined : Number(fromText));
  return {
    kind: "api_error",
    message: result.text,
    ...(status === undefined ? {} : { status }),
    // Z.ai 1113/1316/1317, Moonshot's exceeded_current_quota_error, DeepSeek's 402, MiniMax 1008, DashScope Arrearage.
    ...(outOfBalanceText(status, result.text) ? { quota: true as const } : {}),
  };
}

const NO_TOKENS: ResultEvent["usage"] = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function isRateLimitRetry(event: WorkerEvent): boolean {
  // Only api_retry events carry a status, so dropping the type test changes nothing at run time (an equivalent mutant).
  // Stryker disable next-line ConditionalExpression
  return event.type === "api_retry" && event.status === RATE_LIMIT_STATUS;
}

type ResultEvent = Extract<WorkerEvent, { type: "result" }>;
type WorkerExitStatus = Parameters<typeof finalizeWorker>[1];

function outcomeOf(
  result: ResultEvent | undefined,
  exit: WorkerExitStatus,
  forced: "timeout" | "stopped" | null,
): WorkerOutcome {
  if (forced !== null) return { kind: forced };
  // Even a clean exit without a result event is a crash: every finished run ends with one.
  if (result === undefined) {
    return { kind: "crashed", exitCode: exit.code, signal: exit.signal, stderrTail: exit.stderrTail };
  }
  return result.isError ? apiError(result) : { kind: "completed" };
}

/**
 * Fold a finished attempt: the last `result` event decides completed vs api_error (is_error, message from `text`, status
 * from `api_error_status`, else from the text); no result event → crashed, whatever the exit code; the process layer passes timeout/stopped
 * directly. Usage sums tokens from the result event and counts 429 api_retry events.
 */
export function finalizeWorker(
  events: readonly WorkerEvent[],
  exit: { readonly code: number | null; readonly signal: string | null; readonly stderrTail: string },
  forced: "timeout" | "stopped" | null,
): WorkerResult {
  const result = events.findLast((event) => event.type === "result");
  // An engine-keyed session announces its id as a `session` event, which beats the init line's caller key.
  const session = events.find((event) => event.type === "session");
  const init = events.find((event) => event.type === "init");
  const sessionId =
    session !== undefined ? session.sessionId : init === undefined ? undefined : init.sessionId;
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    outcome: outcomeOf(result, exit, forced),
    usage: {
      turns: result?.turns ?? 0,
      ...(result?.usage ?? NO_TOKENS),
      costUsd: result?.costUsd ?? 0,
      rateLimitRetries: events.filter(isRateLimitRetry).length,
      durationMs: result?.durationMs ?? 0,
      ...(result?.model === undefined ? {} : { model: result.model }),
    },
    report: result?.structuredOutput ?? null,
  };
}
