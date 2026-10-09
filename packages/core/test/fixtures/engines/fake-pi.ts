#!/usr/bin/env node
/**
 * Executable stand-in for `pi --mode rpc` (pi 1.0.4 wire shapes; Node runs it with type stripping). It speaks the
 * same protocol the client expects: no ready frame, `get_state`, `prompt` (admission only — the turn ends at a bare
 * `agent_settled`), `abort`, `get_last_assistant_text`, and the stdin close that saves the session and exits 0.
 * Transcript frames (`agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`,
 * `tool_execution_*`, `turn_end`, `agent_end`) follow the recorded shapes.
 *
 * Environment:
 * - FAKE_PI_SCENARIO      what a prompt does:
 *     ok            "Working on it." deltas, then a final `stop`; FAKE_PI_BAD_REPORT steers the corrections
 *     error         an assistant message that ends stopReason "error" (pi's 401 shape: the prompt was admitted)
 *     sleep         a bash tool that never finishes; `abort` cancels it
 *     ignore-abort  like sleep, but `abort` is acknowledged and ignored, and so is SIGTERM
 *     crash         exits 1 mid-turn with a stderr line
 *     big-frame     a final assistant message with 2 MiB of text (past spawn's 1 MiB default line limit)
 * - FAKE_PI_FIXTURE       a recorded fixture directory replayed in lockstep instead (see replay())
 * - FAKE_PI_WIRE_LOG      a file every stdout line is appended to as written
 * - FAKE_PI_FINAL_TEXT    what the ok scenario's last assistant message says (default "done")
 * - FAKE_PI_BAD_REPORT    while the host keeps correcting, the ok scenario answers with this instead of the final
 *                         text (up to 2 bad turns); the last turn always answers FAKE_PI_FINAL_TEXT
 * - FAKE_PI_TEXTLESS      "1": the ok scenario's final assistant message ends with no text parts; only
 *                         get_last_assistant_text still knows the answer
 * - FAKE_PI_NO_AGENT      "1": the prompt is admitted and settled with no assistant message at all
 * - FAKE_PI_NO_SESSION_ID "1": get_state answers without a sessionId (the protocol refusal)
 * - FAKE_PI_SLOW_STATE_MS delays the get_state answer (the handshake timeout)
 * - FAKE_PI_GARBAGE       "1": prints a line that is not JSON before the first command
 * - FAKE_PI_WARN_SESSION  "0": silences the benign session-create warning (default: printed)
 * - FAKE_PI_VERSION       what `--version` prints after "pi/" (default 1.0.4)
 * - FAKE_PI_ARGV_LOG      a file the command line is written to as a one-line JSON array
 * - FAKE_PI_ENV_LOG       a file the whole environment (FAKE_* names left out) is written to as one JSON object
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

const argv = process.argv.slice(2);
const env = process.env;

if (argv[0] === "--version") {
  process.stdout.write(`pi/${env.FAKE_PI_VERSION ?? "1.0.4"}\n`);
  process.exit(0);
}

const VALUE_FLAGS = new Set(["--mode", "--model", "--thinking", "--tools", "--session-id"]);
const BOOLEAN_FLAGS = new Set(["--no-extensions", "--no-mcp", "--no-skills", "--no-context-files"]);

function parseFlags(): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      flags.set(arg, argv[i] ?? "");
    } else if (BOOLEAN_FLAGS.has(arg)) flags.set(arg, "");
    else {
      process.stderr.write(`Error: Unknown option: ${arg}\n`);
      process.exit(2);
    }
  }
  return flags;
}

const flags = parseFlags();

/** One side of the wire. */
function wire(line: string): void {
  process.stdout.write(line);
  if (env.FAKE_PI_WIRE_LOG !== undefined) appendFileSync(env.FAKE_PI_WIRE_LOG, line);
}

function writeFrame(frame: Json): void {
  wire(`${JSON.stringify(frame)}\n`);
}

/** pi has no event filter and no chunking: every frame goes out whole. */
const emit = writeFrame;

function respond(command: Json, data?: Json): void {
  writeFrame({
    id: command.id,
    type: "response",
    command: String(command.type),
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

/** The session this process stands in for. */
const model = String(flags.get("--model") ?? "zai/glm-5.3").split("/");
const modelProvider = model[0] ?? "zai";
const modelId = model[1] ?? "glm-5.3";
const tools = (flags.get("--tools") ?? "").split(",").filter((tool) => tool !== "");
const sessionId = flags.get("--session-id") ?? "00000000-0000-7000-8000-0000000000ff";
const sessionMessages: Json[] = [];
let messageIds = 0;
let bootstrapped = false;
let lastText = "";
let lastAssistantMessage: Json | undefined;

const stats = {
  userMessages: 0,
  assistantMessages: 0,
  toolCalls: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cost: 0,
};

function state(): Json {
  const base: Json = {
    model: {
      id: modelId,
      name: `Fake ${modelId}`,
      api: "anthropic-messages",
      provider: modelProvider,
      baseUrl: "https://api.z.ai/api/anthropic",
    },
    thinkingLevel: flags.get("--thinking") ?? "medium",
    sessionFile: join(env.PI_CODING_AGENT_DIR ?? process.cwd(), "sessions", `${sessionId}.jsonl`),
    messageCount: sessionMessages.length,
  };
  return env.FAKE_PI_NO_SESSION_ID === "1" ? base : { ...base, sessionId };
}

function messageStart(role: string): void {
  emit({ type: "message_start", message: { role } });
}

/** A sealed message: emitted and kept for agent_end. */
function message(role: string, fields: Json): Json {
  messageIds += 1;
  const built: Json = { role, ...fields, timestamp: Date.now() };
  sessionMessages.push(built);
  emit({ type: "message_end", message: built, messageId: `msg-${messageIds}` });
  return built;
}

function usage(): Json {
  return {
    input: 100,
    output: 20,
    cacheRead: 50,
    cacheWrite: 0,
    totalTokens: 170,
    cost: { input: 0.0001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 },
  };
}

function assistant(content: Json[], stopReason: string, extra: Json = {}): Json {
  stats.assistantMessages += 1;
  stats.input += 100;
  stats.output += 20;
  stats.cacheRead += 50;
  stats.cost += 0.0001;
  messageStart("assistant");
  const built = message("assistant", {
    content,
    api: "anthropic-messages",
    provider: modelProvider,
    model: modelId,
    usage: usage(),
    stopReason,
    ...extra,
  });
  lastAssistantMessage = built;
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => String(part.text))
    .join("");
  if (text !== "") lastText = text;
  return built;
}

function toolCall(id: string, name: string, args: Json): Json {
  stats.toolCalls += 1;
  return { type: "toolCall", id, name, arguments: args };
}

/** The tool result, in pi's two places: its execution end and a toolResult transcript message. */
function toolEnd(id: string, name: string, result: Json, isError: boolean): void {
  emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError });
  messageStart("toolResult");
  turnToolResults.push(
    message("toolResult", {
      toolCallId: id,
      toolName: name,
      content: result.content,
      details: result.details ?? {},
      isError,
    }),
  );
}

/** A streamed assistant text, as pi's message_update events: start, one delta per word, end. */
function textDeltas(text: string): void {
  const streaming = usage();
  const update = (event: Json): void =>
    emit({ type: "message_update", usage: streaming, assistantMessageEvent: { contentIndex: 0, ...event } });
  update({ type: "text_start" });
  for (const word of text.split(/(?<= )/)) update({ type: "text_delta", delta: word });
  update({ type: "text_end", content: text });
}

interface Turn {
  readonly prompt: Json;
  readonly aborted: Promise<Json>;
  abort(command: Json): void;
}

let turn: Turn | undefined;
let inputEnded = false;
let turnToolResults: Json[] = [];
let okTurns = 0;

function startTurn(prompt: Json): Turn {
  let abortResolve: ((command: Json) => void) | undefined;
  const aborted = new Promise<Json>((resolve) => {
    abortResolve = resolve;
  });
  return {
    prompt,
    aborted,
    abort(command: Json): void {
      abortResolve?.(command);
    },
  };
}

function nextTurn(): void {
  emit({ type: "turn_start" });
  turnToolResults = [];
}

/** The transcript bracket every turn shares: agent_start, the session's system message (first turn only),
 *  turn_start, the user message. */
function beginTurn(current: Turn): void {
  emit({ type: "agent_start" });
  if (!bootstrapped) {
    bootstrapped = true;
    messageStart("system");
    message("system", {
      content: "",
      sections: { preamble: "fake pi", tools: tools.join(","), rules: "", docs: "", cwd: process.cwd() },
      toolsAdded: [...tools],
    });
  }
  nextTurn();
  messageStart("user");
  message("user", { content: [{ type: "text", text: String(current.prompt.message ?? "") }] });
}

function turnEnd(): void {
  emit({ type: "turn_end", message: lastAssistantMessage, toolResults: turnToolResults });
}

function settle(): void {
  emit({ type: "agent_end", messages: sessionMessages, willRetry: false });
  writeFrame({ type: "agent_settled" });
  turn = undefined;
  if (inputEnded) exitAfterFlush(0);
}

/** pi's abort order (recorded from 1.0.4): the cancelled tool, the aborted assistant message in a turn of its own,
 *  agent_end, the bare agent_settled — and the abort response last of all. */
function cancelTool(id: string, name: string, abort: Json): void {
  emit({
    type: "tool_execution_update",
    toolCallId: id,
    toolName: name,
    partialResult: { content: [{ type: "text", text: "partial output before the abort" }] },
  });
  toolEnd(id, name, { content: [{ type: "text", text: "Command aborted" }], details: {} }, true);
  turnEnd();
  nextTurn();
  assistant([], "error", { errorMessage: "The operation was aborted." });
  turnEnd();
  settle();
  respond(abort);
}

const finalText = env.FAKE_PI_FINAL_TEXT ?? "done";
/** How many turns the host's corrections keep getting the bad answer; the last turn is always the good one. */
const MAX_REPORT_TRIES = 3;

async function ok(current: Turn): Promise<void> {
  beginTurn(current);
  textDeltas("Working on it.");
  okTurns += 1;
  const text =
    env.FAKE_PI_BAD_REPORT !== undefined && okTurns < MAX_REPORT_TRIES ? env.FAKE_PI_BAD_REPORT : finalText;
  textDeltas(text);
  if (env.FAKE_PI_TEXTLESS === "1") {
    // The message ends with no text parts; only get_last_assistant_text still knows the answer.
    lastText = text;
    assistant([], "stop");
  } else assistant([{ type: "text", text }], "stop");
  turnEnd();
  settle();
}

async function errorTurn(current: Turn): Promise<void> {
  beginTurn(current);
  assistant([], "error", { errorMessage: '401 {"error":{"message":"token expired or incorrect"}}' });
  turnEnd();
  settle();
}

async function longTool(current: Turn): Promise<void> {
  beginTurn(current);
  const id = "call_bash_1";
  assistant([toolCall(id, "bash", { command: "sleep 600" })], "toolUse");
  emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "sleep 600" } });
  const abort = await current.aborted;
  cancelTool(id, "bash", abort);
}

async function bigFrame(current: Turn): Promise<void> {
  beginTurn(current);
  assistant([{ type: "text", text: "y".repeat(2 * 1024 * 1024) }], "stop");
  turnEnd();
  settle();
}

function crash(current: Turn): void {
  beginTurn(current);
  assistant([toolCall("call_bash_1", "bash", { command: "true" })], "toolUse");
  process.stderr.write("fake pi: simulated crash\n");
  process.exit(1);
}

const SCENARIOS: Record<string, (current: Turn) => Promise<void> | void> = {
  ok,
  error: errorTurn,
  sleep: longTool,
  "ignore-abort": longTool,
  "big-frame": bigFrame,
  crash,
};

const COMMANDS: Record<string, (command: Json) => void> = {
  get_state(command) {
    const slow = Number(env.FAKE_PI_SLOW_STATE_MS ?? 0);
    if (slow > 0) setTimeout(() => respond(command, state()), slow);
    else respond(command, state());
  },
  prompt(command) {
    const scenario = SCENARIOS[env.FAKE_PI_SCENARIO ?? "ok"];
    if (scenario === undefined || turn !== undefined) {
      writeFrame({
        id: command.id,
        type: "response",
        command: "prompt",
        success: false,
        error: "cannot prompt now",
      });
      return;
    }
    respond(command, { disposition: "started" });
    const started = startTurn(command);
    turn = started;
    stats.userMessages += 1;
    if (env.FAKE_PI_NO_AGENT === "1") {
      beginTurn(started);
      settle();
      return;
    }
    void scenario(started);
  },
  abort(command) {
    if (turn === undefined || env.FAKE_PI_SCENARIO === "ignore-abort") respond(command);
    else turn.abort(command);
  },
  get_last_assistant_text(command) {
    respond(command, { text: lastText });
  },
};

function handle(line: string): void {
  let command: Json;
  try {
    command = JSON.parse(line) as Json;
  } catch {
    // pi answers a line it could not parse with a response that has no id to correlate.
    writeFrame({ type: "response", command: "parse", success: false });
    return;
  }
  const run = COMMANDS[String(command.type)];
  if (run === undefined) {
    writeFrame({
      id: command.id,
      type: "response",
      command: String(command.type),
      success: false,
      error: `Unknown command: ${String(command.type)}`,
    });
    return;
  }
  run(command);
}

/** Serve mode stays up with a turn owed even after stdin closes (a real pi would be mid-API-call); the interval is
 *  the only handle Node needs to keep the process from exiting on an empty event loop. */
let keepAlive: NodeJS.Timeout | undefined;

function exitAfterFlush(code: number): void {
  if (keepAlive !== undefined) clearInterval(keepAlive);
  process.stdout.write("", () => process.exit(code));
}

async function serve(): Promise<void> {
  keepAlive = setInterval(() => {}, 60_000);
  if (env.FAKE_PI_ARGV_LOG !== undefined) writeFileSync(env.FAKE_PI_ARGV_LOG, `${JSON.stringify(argv)}\n`);
  if (env.FAKE_PI_ENV_LOG !== undefined)
    writeFileSync(
      env.FAKE_PI_ENV_LOG,
      `${JSON.stringify(Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("FAKE_"))))}\n`,
    );
  if (env.FAKE_PI_GARBAGE === "1") wire("this is not json\n");
  if (env.FAKE_PI_WARN_SESSION !== "0")
    process.stderr.write(
      `Warning: No project session found with id '${sessionId}'; creating a new session with that id.\n`,
    );
  if (env.FAKE_PI_SCENARIO === "ignore-abort") process.on("SIGTERM", () => {});
  const input = createInterface({ input: process.stdin });
  input.on("line", handle);
  input.on("close", () => {
    inputEnded = true;
    // A settle still owed keeps the process up; the exit comes once it is sent.
    if (turn === undefined) exitAfterFlush(0);
  });
}

/** Replays a fixture directory in lockstep with the commands the client sends: `out` lines go out in order, `in`
 *  lines wait for that command to arrive (ids remapped to what the client sent), and raw `line` entries emit a
 *  string verbatim (stray output the fixture wants on the wire). */
async function replay(dir: string): Promise<void> {
  process.stderr.write(readFileSync(join(dir, "stderr.txt"), "utf8"));
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Json;
  const entries = readFileSync(join(dir, "interleaved.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { dir: string; frame?: Json; line?: string });
  const inbox = createInbox();
  const ids = new Map<unknown, unknown>();
  for (const entry of entries) {
    if (entry.dir === "in") {
      const sent = await inbox.take(String(entry.frame?.type));
      ids.set(entry.frame?.id, sent.id);
    } else if (entry.line !== undefined) wire(`${entry.line}\n`);
    else replayFrame(entry.frame ?? {}, ids);
  }
  const code = Number(meta.exit);
  if (code === 0) await inbox.ended;
  exitAfterFlush(code);
}

function replayFrame(frame: Json, ids: ReadonlyMap<unknown, unknown>): void {
  writeFrame(ids.has(frame.id) ? { ...frame, id: ids.get(frame.id) } : frame);
}

interface Inbox {
  take(type: string): Promise<Json>;
  readonly ended: Promise<void>;
}

/** Buffers commands until replay waits for one; stdin's end releases any waiter left. */
function createInbox(): Inbox {
  const received: Json[] = [];
  let notify: (() => void) | undefined;
  let endedResolve: (() => void) | undefined;
  const ended = new Promise<void>((resolve) => {
    endedResolve = resolve;
  });
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    try {
      const command = JSON.parse(line) as Json;
      received.push(command);
      notify?.();
    } catch {
      // A line that does not parse is not a command; replay does not wait for it.
    }
  });
  input.on("close", () => endedResolve?.());
  return {
    take(type: string): Promise<Json> {
      return new Promise((resolve) => {
        const poll = (): void => {
          const at = received.findIndex((command) => command.type === type);
          if (at >= 0) resolve(received.splice(at, 1)[0] as Json);
          else {
            notify = poll;
            void ended.then(() => {
              notify = undefined;
            });
          }
        };
        poll();
      });
    },
    ended,
  };
}

if (flags.get("--mode") !== "rpc") {
  process.stderr.write("fake pi: only --mode rpc is supported\n");
  process.exit(2);
}

if (env.FAKE_PI_FIXTURE !== undefined) await replay(env.FAKE_PI_FIXTURE);
else await serve();
