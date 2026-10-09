/** Starts the RPC client against test/fixtures/engines/fake-pi.ts, cleaned up when the current test finishes. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import {
  type PiRpcClient,
  type PiRpcOptions,
  startPiRpc,
} from "../../../../src/adapters/engines/pi-rpc/client.ts";
import type { Frame } from "../../../../src/adapters/engines/pi-rpc/frames.ts";
import { until } from "../../../support/wait.ts";

export const FAKE_PI = join(import.meta.dirname, "../../../fixtures/engines/fake-pi.ts");
export const FIXTURES = join(import.meta.dirname, "../../../fixtures/engines/pi");

/** A readonly session the way the worker starts one (worker.test.ts checks the real argv per access). */
export const SESSION = "00000000-0000-7000-8000-0000000000ff";

export const RPC_ARGS = [
  "--mode",
  "rpc",
  "--model",
  "zai/glm-5.3",
  "--no-extensions",
  "--no-mcp",
  "--no-skills",
  "--no-context-files",
  "--tools",
  "read,grep,find,ls",
  "--session-id",
  SESSION,
];

/** A fresh directory removed after the current test. */
export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-rpc-test-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function startFake(
  fakeEnv: Readonly<Record<string, string>> = {},
  options: Partial<PiRpcOptions> = {},
): Promise<PiRpcClient> {
  const started = await startPiRpc({
    command: FAKE_PI,
    args: RPC_ARGS,
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

/** Replays a recorded fixture through fake-pi. */
export function startFixture(name: string, options: Partial<PiRpcOptions> = {}): Promise<PiRpcClient> {
  return startFake({ FAKE_PI_FIXTURE: join(FIXTURES, name) }, options);
}

/** Collects every frame the client passes through, in order. */
export function collect(client: PiRpcClient): Frame[] {
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

export { isPidAlive as isAlive } from "../../../support/wait.ts";
