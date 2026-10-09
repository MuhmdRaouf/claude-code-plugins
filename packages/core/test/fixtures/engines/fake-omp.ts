#!/usr/bin/env node
/**
 * Executable stand-in for `omp --mode rpc --no-ui` (DESIGN §11.2; Node 24 runs it with type stripping). It speaks
 * the RPC protocol with the shapes recorded from omp 18.6.1 (test/fixtures/engines/omp-rpc/): `ready`, `negotiate_protocol`
 * (v2 turns on `rpc_chunk` framing for frames over 1 MiB), `set_host_tools`, `set_event_filter`, `get_state`,
 * `get_session_stats` (cumulative), `prompt`, `abort` and the stdin close. Like real omp it emits some frames whatever
 * the event filter says: `advisor_cost_changed`, `available_commands_update`, and `message_end` for every role.
 *
 * Environment:
 * - FAKE_OMP_SCENARIO      what a prompt does:
 *     ok            text deltas, then `submit_report` through the host tool (resubmitted while the host replies
 *                   isError, up to 3 tries), then a final `stop`
 *     sleep         a bash tool that never finishes; `abort` cancels it
 *     ignore-abort  like sleep, but `abort` is acknowledged and ignored, and so is SIGTERM
 *     bash-child    like sleep, and the "tool" spawns a grandchild in its own process group (as omp's bash tool
 *                   does); `abort` kills it, a signal to omp's group does not
 *     crash         exits 1 mid-turn with a stderr line
 *     big-frame     a `read` whose tool_execution_end and toolResult message_end each carry 3 MiB of details
 * - FAKE_OMP_FIXTURE       a recorded fixture directory replayed in lockstep instead (see replay())
 * - FAKE_OMP_WIRE_LOG      a file every frame line is appended to as written — the wire before reassembly
 * - FAKE_OMP_REPORT        JSON arguments for submit_report (default {"summary":"fake run"})
 * - FAKE_OMP_LATE_SETTLE   "1": prompt_result says sessionSettled:false; session_settled follows 100 ms later,
 *                          even across a stdin close
 * - FAKE_OMP_NO_AGENT      "1": every prompt finishes at once with agentInvoked:false; no session_settled follows
 * - FAKE_OMP_READY_DELAY_MS  delays `ready`, printing omp's benign "Still starting after 10s" to stderr first
 * - FAKE_OMP_PROTOCOLS     comma list for supportedProtocolVersions (default "1,2")
 * - FAKE_OMP_GARBAGE       "1": prints a line that is not JSON before `ready`
 * - FAKE_OMP_PIDFILE       starts a grandchild in omp's process group that holds stdout open and outlives this
 *                          process; "<own pid> <grandchild pid>" is written here
 * - FAKE_OMP_CHILD_PIDFILE bash-child writes its grandchild's pid here once it runs
 * - FAKE_OMP_VERSION       what `--version` prints after "omp/" (default 18.6.1)
 * - FAKE_OMP_FINAL_TEXT    what the ok scenario's last assistant message says (default "done")
 * - FAKE_OMP_RESUME_MISSING "1": with --resume, `Session "<id>" not found.` on stderr and exit 1, before ready
 * - FAKE_OMP_ARGV_LOG      a file the command line is written to as a one-line JSON array
 * - FAKE_OMP_ENV_LOG       a file the whole environment (FAKE_* names left out) is written to as one JSON object
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

type Json = Record<string, unknown>;

const argv = process.argv.slice(2);
const env = process.env;

if (argv.includes("--version")) {
  process.stdout.write(`omp/${env.FAKE_OMP_VERSION ?? "18.6.1"}\n`);
  process.exit(0);
}

const VALUE_FLAGS = new Set([
  "--mode",
  "--config",
  "--session-dir",
  "--model",
  "--thinking",
  "--tools",
  "--approval-mode",
  "--add-dir",
  "--resume",
]);
const BOOLEAN_FLAGS = new Set(["--no-ui", "--no-extensions", "--no-skills", "--no-rules", "--no-title"]);
/** Frame types omp's event filter applies to; anything else is always emitted. */
const FILTERABLE = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "auto_compaction_start",
  "auto_compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "retry_fallback_applied",
  "notice",
]);
const FRAME_BYTES = 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const MAX_REPORT_TRIES = 3;

function parseFlags(): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (BOOLEAN_FLAGS.has(arg)) flags.set(arg, "");
    else if (VALUE_FLAGS.has(arg) && argv[i + 1] !== undefined) {
      flags.set(arg, argv[i + 1] ?? "");
      i += 1;
    } else {
      process.stderr.write(`Error: Unknown option: ${arg}\n`);
      process.exit(2);
    }
  }
  return flags;
}

// --- output -----------------------------------------------------------------------------------------------------

let protocol = 1;
let filter: Set<string> | undefined;
let chunkIds = 0;

/** Writes one stdout line, recording it on the wire when asked. */
function wire(line: string): void {
  process.stdout.write(line);
  if (env.FAKE_OMP_WIRE_LOG !== undefined) appendFileSync(env.FAKE_OMP_WIRE_LOG, line);
}

function writeFrame(frame: Json): void {
  const text = JSON.stringify(frame);
  const bytes = Buffer.from(text, "utf8");
  if (protocol < 2 || bytes.byteLength + 1 <= FRAME_BYTES) {
    wire(`${text}\n`);
    return;
  }
  chunkIds += 1;
  const count = Math.ceil(bytes.byteLength / CHUNK_BYTES);
  for (let index = 0; index < count; index += 1) {
    const data = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64");
    const chunk = {
      type: "rpc_chunk",
      chunkId: `rpc-${chunkIds}`,
      index,
      count,
      byteLength: bytes.byteLength,
      data,
    };
    wire(`${JSON.stringify(chunk)}\n`);
  }
}

function emit(frame: Json): void {
  const type = String(frame.type);
  if (filter !== undefined && FILTERABLE.has(type) && !filter.has(type)) return;
  writeFrame(frame);
}

function respond(command: Json, data?: unknown): void {
  writeFrame({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

// --- session ----------------------------------------------------------------------------------------------------

const flags = parseFlags();
const model = (flags.get("--model") ?? "zai/glm-5.3").replace(/^zai\//, "");
const tools = (flags.get("--tools") ?? "read,bash,edit,eval,glob,grep,todo,web_search,write").split(",");
const sessionId = "01a11109-0000-7000-8000-000000000001";
let hostTools: Json[] = [];
let messageIds = 0;
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
  return {
    model: { id: model, provider: "zai", api: "anthropic-messages" },
    thinkingLevel: flags.get("--thinking") ?? "low",
    sessionId,
    sessionFile: join(flags.get("--session-dir") ?? process.cwd(), `fake_${sessionId}.jsonl`),
    messageCount: stats.userMessages + stats.assistantMessages,
    dumpTools: [...tools, ...hostTools.map((tool) => String(tool.name))].map((name) => ({ name })),
    systemPrompt: [
      "fake omp system prompt",
      "<project-context>\n<repo-rules>\n</repo-rules>\n</project-context>",
    ],
  };
}

function sessionStats(): Json {
  const { input, output, cacheRead } = stats;
  return {
    sessionId,
    userMessages: stats.userMessages,
    assistantMessages: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    tokens: { input, output, reasoning: 0, cacheRead, cacheWrite: 0, total: input + output + cacheRead },
    cost: stats.cost,
  };
}

function message(role: string, fields: Json): void {
  messageIds += 1;
  emit({
    type: "message_end",
    message: { role, ...fields, timestamp: Date.now() },
    messageId: `msg-${messageIds}`,
  });
}

function assistant(content: Json[], stopReason: string, extra: Json = {}): void {
  stats.assistantMessages += 1;
  stats.input += 100;
  stats.output += 20;
  stats.cacheRead += 50;
  stats.cost += 0.0001;
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 50,
    cacheWrite: 0,
    totalTokens: 170,
    cost: { total: 0.0001 },
  };
  message("assistant", {
    content,
    api: "anthropic-messages",
    provider: "zai",
    model,
    usage,
    stopReason,
    ...extra,
  });
}

function toolCall(id: string, name: string, args: Json, intent: string): Json {
  stats.toolCalls += 1;
  return { type: "toolCall", id, name, arguments: args, intent };
}

function toolEnd(id: string, name: string, result: Json, isError: boolean): void {
  emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError });
  message("toolResult", { toolCallId: id, toolName: name, ...result, isError });
}

function textDeltas(text: string): void {
  const messageId = `msg-${messageIds + 1}`;
  const update = (event: Json): void =>
    emit({
      type: "message_update",
      assistantMessageEvent: { contentIndex: 0, ...event },
      message: { role: "assistant" },
      messageId,
    });
  update({ type: "text_start" });
  for (const word of text.split(/(?<= )/)) update({ type: "text_delta", delta: word });
  update({ type: "text_end" });
}

// --- turns ------------------------------------------------------------------------------------------------------

interface Turn {
  readonly prompt: Json;
  /** Resolves with the abort command when the host aborts this turn. */
  readonly aborted: Promise<Json>;
  abort(command: Json): void;
}

let turn: Turn | undefined;
/** A settle the fake still owes the host; the exit waits for it (omp drains before it exits). */
let settleTimer: NodeJS.Timeout | undefined;
let inputEnded = false;
const hostReplies = new Map<string, (reply: Json) => void>();
let hostCallIds = 0;

function startTurn(prompt: Json): Turn {
  let abort: (command: Json) => void = () => {};
  const aborted = new Promise<Json>((resolve) => {
    abort = resolve;
  });
  return { prompt, aborted, abort: (command) => abort(command) };
}

function finish(status: string): void {
  const prompt = turn?.prompt ?? {};
  const late = env.FAKE_OMP_LATE_SETTLE === "1";
  const noAgent = env.FAKE_OMP_NO_AGENT === "1";
  writeFrame({
    type: "prompt_result",
    id: prompt.id,
    agentInvoked: !noAgent,
    status,
    sessionSettled: !late && !noAgent,
  });
  turn = undefined;
  if (noAgent) {
    if (inputEnded) exitAfterFlush(0);
    return;
  }
  if (late) settleTimer = setTimeout(settled, 100);
  else settled();
}

function settled(): void {
  settleTimer = undefined;
  writeFrame({ type: "session_settled" });
  if (inputEnded) exitAfterFlush(0);
}

/** omp's abort order (O0 P5): the cancelled tool, the aborted assistant message, the abort response, prompt_result. */
function cancelTool(id: string, name: string, abort: Json): void {
  toolEnd(id, name, { content: [{ type: "text", text: "[Command cancelled]\n" }], details: {} }, true);
  endAborted(abort);
}

function endAborted(abort: Json): void {
  assistant([], "aborted", { errorMessage: "Interrupted by user" });
  respond(abort);
  finish("aborted");
}

/** Emits host_tool_call and waits for the host's result, or for an abort (then omp sends host_tool_cancel). */
async function hostCall(
  toolCallId: string,
  name: string,
  args: Json,
  current: Turn,
): Promise<Json | undefined> {
  hostCallIds += 1;
  const id = `host-${hostCallIds}`;
  const reply = new Promise<Json>((resolve) => hostReplies.set(id, resolve));
  writeFrame({ type: "host_tool_call", id, toolCallId, toolName: name, arguments: args });
  const outcome = await Promise.race([
    reply.then((r) => ({ reply: r })),
    current.aborted.then((a) => ({ abort: a })),
  ]);
  hostReplies.delete(id);
  if ("reply" in outcome) return outcome.reply;
  hostCallIds += 1;
  writeFrame({ type: "host_tool_cancel", id: `host-${hostCallIds}`, targetId: id });
  endAborted(outcome.abort);
  return undefined;
}

async function submitReport(current: Turn): Promise<boolean> {
  const report = JSON.parse(env.FAKE_OMP_REPORT ?? '{"summary":"fake run"}') as Json;
  if (!hostTools.some((tool) => tool.name === "submit_report")) return true;
  for (let attempt = 1; attempt <= MAX_REPORT_TRIES; attempt += 1) {
    const id = `call_report_${attempt}`;
    assistant([toolCall(id, "submit_report", report, "Submitting the report")], "toolUse");
    const reply = await hostCall(id, "submit_report", report, current);
    if (reply === undefined) return false;
    emit({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: "submit_report",
      args: report,
      intent: "Submitting the report",
    });
    const isError = reply.isError === true;
    toolEnd(id, "submit_report", { content: (reply.result as Json).content, details: {} }, isError);
    if (!isError) return true;
  }
  return true;
}

/** What the ok scenario's last assistant message says; the worker reads its final text from there. */
const finalText = env.FAKE_OMP_FINAL_TEXT ?? "done";

async function ok(current: Turn): Promise<void> {
  textDeltas("Working on it.");
  if (!(await submitReport(current))) return;
  textDeltas(finalText);
  assistant([{ type: "text", text: finalText }], "stop");
  finish("completed");
}

/** A bash tool that runs until aborted. */
async function longTool(current: Turn, onAbort: () => void = () => {}): Promise<void> {
  const id = "call_bash_1";
  const args = { command: "sleep 600", timeout: 900 };
  assistant([toolCall(id, "bash", args, "Sleeping")], "toolUse");
  emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args, intent: "Sleeping" });
  const abort = await current.aborted;
  onAbort();
  cancelTool(id, "bash", abort);
}

async function bashChild(current: Turn): Promise<void> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (env.FAKE_OMP_CHILD_PIDFILE !== undefined) writeFileSync(env.FAKE_OMP_CHILD_PIDFILE, String(child.pid));
  await longTool(current, () => {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  });
}

async function bigFrame(current: Turn): Promise<void> {
  const id = "call_read_1";
  const details = { displayContent: { text: "y".repeat(3 * 1024 * 1024) } };
  const result = { content: [{ type: "text", text: "y".repeat(40 * 1024) }], details };
  assistant([toolCall(id, "read", { path: "big.txt" }, "Reading big.txt")], "toolUse");
  emit({
    type: "tool_execution_start",
    toolCallId: id,
    toolName: "read",
    args: { path: "big.txt" },
    intent: "Reading big.txt",
  });
  toolEnd(id, "read", result, false);
  await ok(current);
}

function crash(): void {
  assistant([toolCall("call_bash_1", "bash", { command: "true" }, "Checking")], "toolUse");
  process.stderr.write("fake omp: simulated crash\n");
  process.exit(1);
}

const SCENARIOS: Record<string, (current: Turn) => Promise<void> | void> = {
  ok,
  sleep: (current) => longTool(current),
  "ignore-abort": (current) => longTool(current),
  "bash-child": bashChild,
  "big-frame": bigFrame,
  crash,
};

function prompt(command: Json): void {
  const scenario = SCENARIOS[env.FAKE_OMP_SCENARIO ?? "ok"];
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
  respond(command);
  turn = startTurn(command);
  stats.userMessages += 1;
  message("user", { content: [{ type: "text", text: String(command.message) }], attribution: "user" });
  writeFrame({ type: "advisor_cost_changed" });
  // A prompt that invokes no agent (FAKE_OMP_NO_AGENT): answered without the scenario's agent activity.
  if (env.FAKE_OMP_NO_AGENT === "1") {
    finish("completed");
    return;
  }
  void scenario(turn);
}

function abort(command: Json): void {
  if (turn === undefined || env.FAKE_OMP_SCENARIO === "ignore-abort") respond(command);
  else turn.abort(command);
}

// --- commands ---------------------------------------------------------------------------------------------------

const COMMANDS: Record<string, (command: Json) => void> = {
  negotiate_protocol(command) {
    protocol = Number(command.protocolVersion);
    respond(command, { protocolVersion: protocol });
  },
  set_host_tools(command) {
    hostTools = (command.tools as Json[]) ?? [];
    respond(command, { toolNames: hostTools.map((tool) => tool.name) });
  },
  set_event_filter(command) {
    filter = new Set(command.events as string[]);
    respond(command, { events: command.events, messageUpdates: command.messageUpdates });
  },
  get_state: (command) => respond(command, state()),
  get_session_stats: (command) => respond(command, sessionStats()),
  prompt,
  abort,
  host_tool_result(command) {
    hostReplies.get(String(command.id))?.(command);
  },
};

function handle(line: string): void {
  const command = JSON.parse(line) as Json;
  const run = COMMANDS[String(command.type)];
  if (run !== undefined) run(command);
  else
    writeFrame({
      id: command.id,
      type: "response",
      command: command.type,
      success: false,
      error: `Unknown command: ${String(command.type)}`,
    });
}

function exitAfterFlush(code: number): void {
  process.stdout.write("", () => process.exit(code));
}

function startGrandchild(pidFile: string): void {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  grandchild.unref();
  writeFileSync(pidFile, `${process.pid} ${grandchild.pid}`);
}

/** The environment as the tool sees it, the test harness's own FAKE_* knobs left out. */
function ownEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("FAKE_")));
}

async function serve(): Promise<void> {
  if (env.FAKE_OMP_ARGV_LOG !== undefined) writeFileSync(env.FAKE_OMP_ARGV_LOG, `${JSON.stringify(argv)}\n`);
  if (env.FAKE_OMP_ENV_LOG !== undefined) {
    writeFileSync(env.FAKE_OMP_ENV_LOG, `${JSON.stringify(ownEnv())}\n`);
  }
  if (env.FAKE_OMP_RESUME_MISSING === "1" && flags.get("--resume") !== undefined) {
    process.stderr.write(`Session "${flags.get("--resume")}" not found.\n`);
    process.exit(1);
  }
  if (env.FAKE_OMP_SCENARIO === "ignore-abort") process.on("SIGTERM", () => {});
  if (env.FAKE_OMP_PIDFILE !== undefined) startGrandchild(env.FAKE_OMP_PIDFILE);
  if (env.FAKE_OMP_GARBAGE === "1") process.stdout.write("this is not json\n");
  const readyDelay = Number(env.FAKE_OMP_READY_DELAY_MS ?? 0);
  if (readyDelay > 0) {
    process.stderr.write("Still starting after 10s — phase: discoverCustomToolPaths\n");
    await delay(readyDelay);
  }
  const versions = (env.FAKE_OMP_PROTOCOLS ?? "1,2").split(",").map(Number);
  writeFrame({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: versions,
    maxFrameBytes: FRAME_BYTES,
  });
  writeFrame({ type: "advisor_cost_changed" });
  writeFrame({
    type: "available_commands_update",
    commands: [{ name: "dump", description: "Dump the session" }],
  });
  const input = createInterface({ input: process.stdin });
  input.on("line", handle);
  input.on("close", () => {
    inputEnded = true;
    // A settle still owed keeps the process up; the exit comes once it is sent.
    if (turn === undefined && settleTimer === undefined) exitAfterFlush(0);
  });
}

// --- fixture replay ---------------------------------------------------------------------------------------------

/**
 * Replays a recorded fixture (its interleaved.jsonl) in lockstep: outbound frames are written in order, and before
 * each recorded inbound command it waits for the host to send a command of that type. Recorded command ids are
 * mapped to the host's ids, so responses and prompt_results correlate. stderr.txt is written first; at the end it
 * exits with the recorded code, after stdin closes when that code is 0.
 */
async function replay(dir: string): Promise<void> {
  process.stderr.write(readFileSync(join(dir, "stderr.txt"), "utf8"));
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Json;
  const entries = readFileSync(join(dir, "interleaved.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { dir: string; frame: Json });
  const inbox = createInbox();
  const ids = new Map<unknown, unknown>();
  for (const entry of entries) {
    if (entry.dir === "in") {
      const sent = await inbox.take(String(entry.frame.type));
      ids.set(entry.frame.id, sent.id);
    } else replayFrame(entry.frame, ids);
  }
  const code = Number(meta.exit);
  if (code === 0) await inbox.ended;
  exitAfterFlush(code);
}

/** Writes a recorded frame with the host's id in place of the recorded one. */
function replayFrame(frame: Json, ids: ReadonlyMap<unknown, unknown>): void {
  writeFrame(ids.has(frame.id) ? { ...frame, id: ids.get(frame.id) } : frame);
  if (frame.type === "response" && frame.command === "negotiate_protocol") protocol = 2;
}

function createInbox(): { take(type: string): Promise<Json>; ended: Promise<void> } {
  const received: Json[] = [];
  let waiter: (() => void) | undefined;
  let end: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    received.push(JSON.parse(line) as Json);
    waiter?.();
  });
  input.on("close", end);
  return {
    ended,
    async take(type) {
      for (;;) {
        const at = received.findIndex((command) => command.type === type);
        if (at !== -1) return received.splice(at, 1)[0] as Json;
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
    },
  };
}

// --- main -------------------------------------------------------------------------------------------------------

if (flags.get("--mode") !== "rpc") {
  process.stderr.write("fake omp: only --mode rpc is supported\n");
  process.exit(2);
}
if (env.FAKE_OMP_FIXTURE !== undefined) await replay(env.FAKE_OMP_FIXTURE);
else await serve();
