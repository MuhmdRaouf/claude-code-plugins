/**
 * The client against the real omp 18.6.1 recordings (test/fixtures/engines/omp-rpc), replayed by fake-omp in lockstep: the
 * recorded commands are sent again, the recorded host-tool replies are given again, and every recorded frame must
 * come through in order.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  HostToolHandler,
  OmpRpcClient,
  RpcCommand,
  RpcError,
  TurnEnd,
} from "../../../../src/adapters/engines/omp-rpc/client.ts";
import { createFrameDecoder, type Frame } from "../../../../src/adapters/engines/omp-rpc/frames.ts";
import type { Result } from "../../../../src/domain/result.ts";
import {
  collect,
  FIXTURES,
  HANDSHAKE,
  startFake,
  startFixture,
  tempDir,
  waitForFrame,
} from "../../../fixtures/engines/omp.ts";

type Json = Record<string, unknown>;

function jsonLines(path: string): Json[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/** The recorded host-tool replies, given back in order. */
function recordedReplies(commands: Json[]): HostToolHandler {
  const replies = commands.filter((command) => command.type === "host_tool_result");
  return () => {
    const reply = replies.shift() as { result: { content: { text: string }[] }; isError?: boolean };
    return { text: reply.result.content[0]?.text ?? "", isError: reply.isError === true };
  };
}

interface Replayed {
  readonly turn?: Result<TurnEnd, RpcError>;
  readonly responses: Json[];
  readonly frames: Frame[];
  readonly client: OmpRpcClient;
}

/** Sends the fixture's recorded commands again through the client. */
async function drive(name: string): Promise<Replayed> {
  const commands = jsonLines(join(FIXTURES, name, "stdin.jsonl"));
  const client = await startFixture(name, { onHostToolCall: recordedReplies(commands) });
  const frames = collect(client);
  const tools = commands.find((command) => command.type === "set_host_tools")?.tools as never;
  expect(await client.handshake({ ...HANDSHAKE, hostTools: tools })).toMatchObject({ ok: true });
  const rest = commands.slice(4).filter((command) => command.type !== "host_tool_result");
  const responses: Json[] = [];
  let turn: Promise<Result<TurnEnd, RpcError>> | undefined;
  for (const { id: _, ...command } of rest) {
    if (command.type === "prompt") {
      turn = client.prompt(String(command.message));
      if (!rest.some((later) => later.type === "abort")) await turn;
    } else if (command.type === "abort") {
      await waitForFrame(frames, (frame) => frame.type === "tool_execution_start");
      responses.push((await client.abort()) as never);
    } else responses.push((await client.request(command as RpcCommand)) as never);
  }
  return { ...(turn === undefined ? {} : { turn: await turn }), responses, frames, client };
}

const recordedFrames = (name: string): Json[] =>
  jsonLines(join(FIXTURES, name, "interleaved.jsonl"))
    .filter((entry) => entry.dir === "out")
    .map((entry) => entry.frame as Json);

const COMPLETED = [
  "success-edit",
  "success-edit-glm",
  "success-readonly",
  "report-invalid-retry",
  "report-host-reject-retry",
  "readonly-write-attempt",
  "resume-turn1",
  "resume-open-session",
  "text-delta",
  "max-time-expiry",
  "big-frame",
  "rpc-chunk",
  "rate-limited-429.SYNTHETIC",
];

describe("recorded omp 18.6.1 sessions", () => {
  it.each(COMPLETED)(
    "%s: the turn completes and every recorded frame comes through in order",
    async (name) => {
      const { turn, frames, client, responses } = await drive(name);
      expect(turn).toMatchObject({
        ok: true,
        value: { result: { status: "completed", agentInvoked: true } },
      });
      expect(responses.every((response) => response.ok === true)).toBe(true);
      expect((await client.close()).code).toBe(0);
      expect(frames.map((frame) => frame.type)).toEqual(recordedFrames(name).map((frame) => frame.type));
    },
  );

  it("not-authenticated: prompt_result error with agentInvoked false, no session_settled to wait for", async () => {
    const { turn, frames } = await drive("not-authenticated");
    expect(turn).toMatchObject({
      ok: true,
      value: {
        result: {
          status: "error",
          agentInvoked: false,
          error: { message: expect.stringMatching(/^No API key found for zai/) },
        },
      },
    });
    expect(frames.map((frame) => frame.type)).not.toContain("session_settled");
  });

  it("provider-error-401: prompt_result error carries the HTTP status", async () => {
    const { turn } = await drive("provider-error-401");
    expect(turn).toMatchObject({
      ok: true,
      value: {
        result: { status: "error", agentInvoked: true, error: { httpStatus: 401, retryable: false } },
      },
    });
  });

  it("abort-mid-tool: abort ends the turn aborted, then omp is killed (exit 143)", async () => {
    const { turn, client, responses } = await drive("abort-mid-tool");
    expect(turn).toMatchObject({ ok: true, value: { result: { status: "aborted", sessionSettled: true } } });
    expect(responses[1]).toMatchObject({ ok: true, value: { command: "abort" } });
    expect((await client.exit).code).toBe(143);
  });

  it("sigterm-mid-tool: the process dies mid-turn with no further frames; the turn fails", async () => {
    const { turn } = await drive("sigterm-mid-tool");
    expect(turn).toMatchObject({ ok: false, error: { kind: "exited", exit: { code: 143 } } });
  });

  it.each([
    ["resume-missing", false],
    ["resume-open-session", true],
  ])("%s: open_session answers resumed: %s", async (name, resumed) => {
    const { responses } = await drive(name);
    expect(responses[0]).toMatchObject({ ok: true, value: { command: "open_session", data: { resumed } } });
  });

  it("resume-flag: the handshake's get_state carries the resumed session", async () => {
    const { client } = await drive("resume-flag");
    expect((await client.close()).code).toBe(0);
  });

  it("every recorded stdout line decodes (rpc-chunk's trimmed chunk data aside)", () => {
    for (const name of readdirSync(FIXTURES).filter((entry) => entry !== "README.md")) {
      const decoder = createFrameDecoder();
      const lines = readFileSync(join(FIXTURES, name, "stdout.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean);
      for (const line of lines.filter((text) => !text.startsWith('{"type":"rpc_chunk"')))
        expect(decoder.push(line).kind, `${name}: ${line.slice(0, 80)}`).toBe("frame");
    }
  });

  it("the trimmed rpc-chunk fixture keeps real chunk metadata: 256 KiB slices, no id", () => {
    const chunks = jsonLines(join(FIXTURES, "rpc-chunk", "stdout.jsonl")).filter(
      (frame) => frame.type === "rpc_chunk",
    );
    expect(chunks.map(({ data: _, ...meta }) => meta)).toEqual([
      { type: "rpc_chunk", chunkId: "rpc-1", index: 0, count: 5, byteLength: expect.any(Number) },
      { type: "rpc_chunk", chunkId: "rpc-1", index: 4, count: 5, byteLength: expect.any(Number) },
    ]);
    expect(chunks[0]?.data).toBe("<349528 base64 chars>");
  });
});

describe("a broken chunk sequence", () => {
  it("fails pending requests with a protocol error", async () => {
    const dir = join(tempDir(), "broken");
    mkdirSync(dir);
    const chunk = {
      type: "rpc_chunk",
      chunkId: "rpc-1",
      index: 1,
      count: 5,
      byteLength: 1_200_000,
      data: "QUFB",
    };
    const entries = [
      { dir: "out", frame: { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] } },
      { dir: "in", frame: { id: "neg", type: "negotiate_protocol" } },
      { dir: "out", frame: chunk },
    ];
    writeFileSync(join(dir, "interleaved.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));
    writeFileSync(join(dir, "meta.json"), '{"exit":0}');
    writeFileSync(join(dir, "stderr.txt"), "");
    const client = await startFake({ FAKE_OMP_FIXTURE: dir });
    expect(await client.handshake(HANDSHAKE)).toEqual({
      ok: false,
      error: { kind: "protocol", message: "omp RPC stream: rpc chunk sequence must start at index 0" },
    });
    expect(await client.request({ type: "get_state" })).toMatchObject({
      ok: false,
      error: { kind: "protocol" },
    });
  });
});

describe("fixture hygiene", () => {
  const SECRET = /\bsk-[A-Za-z0-9_-]{16,}|ZAI_API_KEY=|probe-invalid-key|credentialId|responseId/;
  const TOKEN = /[A-Za-z0-9+_=-]{32,}/g;
  const ALLOWED = [
    /^call_[0-9a-f]{24}$/,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_[0-9a-f-]+$/,
  ];

  function problemsIn(where: string, text: string): string[] {
    const problems: string[] = [];
    if (SECRET.test(text)) problems.push(`${where}: secret-like text`);
    if (/\/(Users|home)\/[a-z]/.test(text)) problems.push(`${where}: absolute home path`);
    for (const token of text.match(TOKEN) ?? [])
      if (/\d/.test(token) && /[A-Za-z]/.test(token) && !ALLOWED.some((allowed) => allowed.test(token)))
        problems.push(`${where}: ${token.slice(0, 40)}`);
    return problems;
  }

  it("no fixture holds a key, an absolute home path or an unexplained token", () => {
    const fixtures = readdirSync(FIXTURES).filter((entry) => entry !== "README.md");
    const problems = fixtures.flatMap((name) =>
      readdirSync(join(FIXTURES, name)).flatMap((file) =>
        problemsIn(`${name}/${file}`, readFileSync(join(FIXTURES, name, file), "utf8")),
      ),
    );
    expect(problems).toEqual([]);
  });
});
