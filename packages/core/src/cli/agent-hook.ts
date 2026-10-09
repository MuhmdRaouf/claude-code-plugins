// The SubagentStop hook: after one of the plugin's model agents finishes, tell the user (a `systemMessage`, never
// Claude's context) what it really ran on. The agent's own transcript is the ground truth: every assistant entry
// names the model that answered. On the provider's model it says so with the tokens and the estimated cost; on a
// Claude model the router was down or setup never ran, and the line says how to fix it. Any problem means silence.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Provider } from "../domain/provider.ts";
import { count, plural, usd } from "../render/format.ts";
import { costUsdOf, type TokenCounts } from "../render/prices.ts";

/** The part of Claude Code's SubagentStop input the hook reads; every field may be missing. */
export interface AgentStopInput {
  readonly agent_type?: unknown;
  readonly agent_id?: unknown;
  readonly agent_transcript_path?: unknown;
  readonly transcript_path?: unknown;
  readonly session_id?: unknown;
}

/** What one agent's transcript says it ran on: the models that answered and what they used. */
interface AgentRun extends TokenCounts {
  readonly models: readonly string[];
  readonly requests: number;
}

/** The newest bytes of a transcript the hook reads: a long agent's file can be large, and the hook has under a
 *  second. Usage counted from the tail undercounts such a run, never overcounts it. */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/** The plugin model agent this input is about, or undefined for any other agent (another plugin's, a built-in). */
export function modelAgentOf(provider: Provider, input: AgentStopInput): string | undefined {
  if (typeof input.agent_type !== "string") return undefined;
  const name = input.agent_type.startsWith(provider.agentPrefix)
    ? input.agent_type.slice(provider.agentPrefix.length)
    : input.agent_type;
  return Object.values(provider.agents).includes(name) ? name : undefined;
}

/** The agent's transcript: the path Claude Code passes, else `<session dir>/subagents/agent-<id>.jsonl` beside the
 *  main transcript. */
export function transcriptPathOf(input: AgentStopInput): string | undefined {
  if (typeof input.agent_transcript_path === "string" && input.agent_transcript_path !== "")
    return input.agent_transcript_path;
  const { transcript_path: main, agent_id: id, session_id: session } = input;
  if (typeof main !== "string" || typeof id !== "string" || typeof session !== "string") return undefined;
  return join(dirname(main), session, "subagents", `agent-${id}.jsonl`);
}

/** Folds transcript JSONL: one request per distinct assistant message id, usage taken once per message. */
export function agentRun(jsonl: string): AgentRun {
  const models = new Set<string>();
  const seen = new Set<string>();
  const run = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const line of jsonl.split("\n")) {
    const message = assistantMessage(line);
    if (message === undefined) continue;
    const { id, model, usage } = message;
    if (model === "<synthetic>") continue;
    models.add(model);
    if (id !== undefined && seen.has(id)) continue;
    if (id !== undefined) seen.add(id);
    run.requests += 1;
    run.inputTokens += tokens(usage, "input_tokens");
    run.outputTokens += tokens(usage, "output_tokens");
    run.cacheReadTokens += tokens(usage, "cache_read_input_tokens");
    run.cacheWriteTokens += tokens(usage, "cache_creation_input_tokens");
  }
  return { models: [...models], ...run };
}

interface AssistantMessage {
  readonly id?: string;
  readonly model: string;
  readonly usage: unknown;
}

function assistantMessage(line: string): AssistantMessage | undefined {
  if (!line.includes('"assistant"')) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = entry as {
    type?: unknown;
    message?: { id?: unknown; model?: unknown; usage?: unknown };
  } | null;
  if (record?.type !== "assistant" || typeof record.message?.model !== "string") return undefined;
  const { id, model, usage } = record.message;
  return { ...(typeof id === "string" ? { id } : {}), model, usage };
}

function tokens(usage: unknown, key: string): number {
  const value = (usage as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Whether a model id is Anthropic's (the Sonnet fallback) rather than the provider's. */
function isClaudeModel(model: string): boolean {
  return model.startsWith("claude");
}

/** The user's line about one finished agent, or undefined when there is nothing worth saying. */
export function agentStopMessage(
  provider: Provider,
  agent: string,
  run: AgentRun,
  setupDone: boolean,
): string | undefined {
  if (run.models.length === 0) return undefined;
  const label = `${provider.agentPrefix}${agent}`;
  const own = run.models.filter((model) => !isClaudeModel(model));
  if (own.length === 0) {
    const why = setupDone
      ? `the ${provider.name} router was down; run ${provider.slash}setup`
      : `${provider.name} is not set up yet; run ${provider.slash}setup`;
    return `${label} ran on Sonnet: ${why}.`;
  }
  const cost = own.length === 1 ? costUsdOf(own[0] ?? "", run) : 0;
  const priced = own.length === 1 && cost > 0 ? `, est. ${usd(cost)}` : "";
  const mixed = own.length < run.models.length ? " (part of it on Sonnet: the router dropped out)" : "";
  return `${label} ran on ${own.join(", ")} via the ${provider.name} router: ${plural(run.requests, "request")}, ${count(run.inputTokens + run.cacheReadTokens + run.cacheWriteTokens)} in / ${count(run.outputTokens)} out${priced}${mixed}.`;
}

/** The newest TRANSCRIPT_TAIL_BYTES of a file, from the first whole line; undefined when it cannot be read. */
export function readTail(path: string, max = TRANSCRIPT_TAIL_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** stdin as text, or what arrived of it within `ms`: a hook never waits on a pipe that stays open. */
export function readStdinWithin(ms: number, stdin: NodeJS.ReadableStream = process.stdin): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = (): void => {
      clearTimeout(timer);
      stdin.removeAllListeners("data");
      stdin.removeAllListeners("end");
      stdin.removeAllListeners("error");
      if ("pause" in stdin) stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(done, ms);
    stdin.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    stdin.on("end", done);
    stdin.on("error", done);
  });
}
