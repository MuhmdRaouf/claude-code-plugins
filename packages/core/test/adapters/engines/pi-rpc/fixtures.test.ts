/** Replays every recorded pi fixture through fake-pi and checks the wire traffic round-trips: the frames the
 *  client saw must be exactly the frames the recording saw, in order, and each run must end as recorded. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PiRpcClient,
  PiRpcOptions,
  RpcError,
  TurnEnd,
} from "../../../../src/adapters/engines/pi-rpc/client.ts";
import { createFrameDecoder, type Frame } from "../../../../src/adapters/engines/pi-rpc/frames.ts";
import { isResponse, type RpcResponse } from "../../../../src/adapters/engines/pi-rpc/messages.ts";
import type { Result } from "../../../../src/domain/result.ts";
import { collect, FIXTURES, startFixture, tempDir, waitForFrame } from "./harness.ts";

const HANDSHAKE = { timeoutMs: 30_000 };

function jsonLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

interface Replayed {
  readonly turn: Promise<Result<TurnEnd, RpcError>>;
  readonly responses: readonly Result<RpcResponse, RpcError>[];
  readonly frames: readonly Frame[];
  readonly client: PiRpcClient;
}

/** Speaks the recorded commands to the replaying fake, in the recorded order. */
async function drive(name: string, options: Partial<PiRpcOptions> = {}): Promise<Replayed> {
  const recorded = jsonLines(join(FIXTURES, name, "stdin.jsonl")).map(
    (line) => JSON.parse(line) as { type: string; message?: unknown },
  );
  const client = await startFixture(name, options);
  const frames = collect(client);
  // The client speaks first: its handshake get_state stands in for the recorded one.
  const shake = await client.handshake(HANDSHAKE);
  if (!shake.ok) throw new Error(shake.error.message);
  const rest = recorded.filter((command) => command.type !== "get_state");
  const responses: Result<RpcResponse, RpcError>[] = [];
  let turn: Promise<Result<TurnEnd, RpcError>> | undefined;
  for (const command of rest) {
    if (command.type === "prompt") {
      turn = client.prompt(String(command.message));
      // An abort fixture's turn cannot settle until the abort arrives; the recording proves the timing instead.
      if (!rest.some((later) => later.type === "abort")) await turn;
    } else if (command.type === "abort") {
      await waitForFrame(frames, (frame) => frame.type === "tool_execution_start");
      responses.push(await client.abort());
    } else {
      responses.push(await client.request(command));
    }
  }
  if (turn === undefined) throw new Error(`fixture ${name} recorded no prompt`);
  return { turn, responses, frames, client };
}

/** The frames the recording saw on stdout, in order. */
function recordedFrames(name: string): Frame[] {
  return jsonLines(join(FIXTURES, name, "interleaved.jsonl"))
    .map((line) => JSON.parse(line) as { dir: string; frame?: Frame })
    .filter((entry) => entry.dir === "out" && entry.frame !== undefined)
    .map((entry) => entry.frame as Frame);
}

/** The fixture directories that run to completion without an abort. */
const COMPLETED = ["success-readonly", "error-after-success", "resume-turn2", "malformed-line"] as const;
/** The fixture directories whose recording includes an abort mid-tool. */
const ABORTED = ["abort-mid-run", "hang-mid-tool"] as const;

describe("recorded pi runs", () => {
  it.each(COMPLETED)("%s replays to the same frames and settles as recorded", async (name) => {
    const { turn, frames, client } = await drive(name);
    expect(await turn).toMatchObject({ ok: true });
    expect(await client.close()).toEqual({ code: 0, signal: null, stderrTail: "", forced: null });
    expect(frames.map((frame) => frame.type)).toEqual(recordedFrames(name).map((frame) => frame.type));
  });

  it.each(ABORTED)("%s settles before the abort response, in pi's own order", async (name) => {
    const { turn, responses, frames, client } = await drive(name);
    expect(await turn).toMatchObject({ ok: true });
    expect(responses).toEqual([
      expect.objectContaining({ ok: true, value: expect.objectContaining({ command: "abort" }) }),
    ]);
    expect(await client.close()).toEqual({ code: 0, signal: null, stderrTail: "", forced: null });
    expect(frames.map((frame) => frame.type)).toEqual(recordedFrames(name).map((frame) => frame.type));
    // pi answers abort only once the agent has settled; the replay must keep that order.
    const settledAt = frames.findIndex((frame) => frame.type === "agent_settled");
    const abortReplyAt = frames.findIndex((frame) => isResponse(frame) && frame.command === "abort");
    expect(settledAt).toBeGreaterThanOrEqual(0);
    expect(abortReplyAt).toBeGreaterThan(settledAt);
  });

  it("a stray non-JSON line rides the wire, lands in the stdout log verbatim, and the turn still settles", async () => {
    const dir = tempDir();
    const log = { stdout: join(dir, "a.jsonl"), stdin: join(dir, "a.rpc-in.jsonl"), promptRef: "ref" };
    const { turn, client } = await drive("malformed-line", { log });
    expect(await turn).toMatchObject({ ok: true });
    expect(await client.close()).toMatchObject({ code: 0 });
    expect(jsonLines(log.stdout)).toContain("this is not json");
  });

  it("every recorded stdout line decodes as an RPC frame, except the deliberate stray", () => {
    for (const name of readdirSync(FIXTURES).filter((entry) => entry !== "README.md")) {
      const decoder = createFrameDecoder();
      for (const line of jsonLines(join(FIXTURES, name, "stdout.jsonl"))) {
        const decoded = decoder.push(line);
        if (name === "malformed-line" && line === "this is not json") {
          expect(decoded).toMatchObject({ kind: "malformed" });
        } else {
          expect(decoded).toMatchObject({ kind: "frame" });
        }
      }
    }
  });
});

describe("fixture hygiene", () => {
  const SECRET = /\bsk-[A-Za-z0-9_-]{16,}|ZAI_API_KEY=|probe-invalid-key|credentialId|responseId/;
  const TOKEN = /[A-Za-z0-9+_=-]{32,}/g;
  // Shapes the recordings legitimately carry: tool call ids, session ids, file stamps.
  const ALLOWED = [
    /^call_[0-9a-f]{24}$/,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_[0-9a-f-]+$/,
  ];

  function problemsIn(where: string, text: string): string[] {
    const problems: string[] = [];
    if (SECRET.test(text)) problems.push(`${where}: secret-looking text`);
    if (/\/(Users|home)\/[a-z]/.test(text)) problems.push(`${where}: absolute home path`);
    for (const token of text.match(TOKEN) ?? []) {
      if (/\d/.test(token) && /[A-Za-z]/.test(token) && !ALLOWED.some((pattern) => pattern.test(token))) {
        problems.push(`${where}: long token ${token.slice(0, 8)}…`);
      }
    }
    return problems;
  }

  it("carries no secrets, tokens or home paths", () => {
    const problems: string[] = [];
    for (const name of readdirSync(FIXTURES).filter((entry) => entry !== "README.md")) {
      for (const file of readdirSync(join(FIXTURES, name))) {
        const text = readFileSync(join(FIXTURES, name, file), "utf8");
        problems.push(...problemsIn(`${name}/${file}`, text));
      }
    }
    expect(problems).toEqual([]);
  });
});
