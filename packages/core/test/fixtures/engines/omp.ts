/** Starts the RPC client against test/fixtures/engines/fake-omp.ts, cleaned up when the current test finishes. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import {
  type EventFilter,
  type HandshakeOptions,
  type HostToolSpec,
  type OmpRpcClient,
  type OmpRpcOptions,
  startOmpRpc,
} from "../../../src/adapters/engines/omp-rpc/client.ts";
import type { Frame } from "../../../src/adapters/engines/omp-rpc/frames.ts";
import { until } from "../../support/wait.ts";

export const FAKE_OMP = join(import.meta.dirname, "fake-omp.ts");
export const FIXTURES = join(import.meta.dirname, "omp-rpc");

/** DESIGN §3.1 step 3. */
export const EVENT_FILTER: EventFilter = {
  events: [
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "auto_retry_start",
    "auto_retry_end",
    "retry_fallback_applied",
    "auto_compaction_start",
    "auto_compaction_end",
    "notice",
  ],
  messageUpdates: "delta",
};

/** The same schema the O0 probes used. */
export const SUBMIT_REPORT: HostToolSpec = {
  name: "submit_report",
  label: "Submit report",
  description: "Submit your final structured report. Call it exactly once, as your last action.",
  parameters: {
    type: "object",
    properties: { status: { type: "string", enum: ["done", "blocked"] }, summary: { type: "string" } },
    required: ["status", "summary"],
  },
  loadMode: "essential",
};

export const HANDSHAKE: HandshakeOptions = {
  hostTools: [SUBMIT_REPORT],
  eventFilter: EVENT_FILTER,
  timeoutMs: 30_000,
};

export const READONLY_ARGS = [
  "--mode",
  "rpc",
  "--no-ui",
  "--tools",
  "read,grep,glob",
  "--approval-mode",
  "yolo",
];

/** A fresh directory removed after the current test. */
export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omp-rpc-test-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function startFake(
  fakeEnv: Readonly<Record<string, string>> = {},
  options: Partial<OmpRpcOptions> = {},
): Promise<OmpRpcClient> {
  const started = await startOmpRpc({
    command: FAKE_OMP,
    args: READONLY_ARGS,
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...fakeEnv },
    ...options,
  });
  if (!started.ok) throw new Error(started.error.message);
  const client = started.value;
  onTestFinished(async () => {
    client.kill("SIGKILL");
    await client.exit;
  });
  return client;
}

/** Replays a recorded fixture through fake-omp. */
export function startFixture(name: string, options: Partial<OmpRpcOptions> = {}): Promise<OmpRpcClient> {
  return startFake({ FAKE_OMP_FIXTURE: join(FIXTURES, name) }, options);
}

/** Collects every frame the client passes through, in order. */
export function collect(client: OmpRpcClient): Frame[] {
  const seen: Frame[] = [];
  void (async () => {
    for await (const frame of client.frames) seen.push(frame);
  })();
  return seen;
}

/** Resolves with the first frame matching `predicate`, failing the test after `ms`. */
export function waitForFrame(
  seen: Frame[],
  predicate: (frame: Frame) => boolean,
  ms = 10_000,
): Promise<Frame> {
  return until(() => seen.find(predicate), { timeoutMs: ms, message: "frame did not arrive" });
}

export { isPidAlive as isAlive } from "../../support/wait.ts";
