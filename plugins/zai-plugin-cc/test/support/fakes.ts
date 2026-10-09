/**
 * zai's side of the shared fakes: the scripted worker speaks claude's stream-json and tells a missing session the way
 * the claude worker does, and the host reports zai's key line. Everything else is core's.
 */

import { CLAUDE_CAPS, claudeSessionMissing } from "@muhmdraouf/core/adapters/claude-headless.ts";
import { keySource } from "@muhmdraouf/core/adapters/key.ts";
import type { SetupCheck } from "@muhmdraouf/core/app/deps.ts";
import { keyCheck } from "@muhmdraouf/core/cli/wire.ts";
import { parseStreamLine } from "@muhmdraouf/core/domain/stream-parse.ts";
import {
  fakeDeps as coreFakeDeps,
  FakeHost,
  type Fakes,
  VALID_CHANGE_REPORT,
  type WorkerDialect,
  type WorkerScript,
} from "@muhmdraouf/core/testing";
import { ZAI_PROVIDER } from "../../src/provider.ts";

export {
  type Fakes,
  RecordingOutput,
  VALID_CHANGE_REPORT,
  type WorkerScript,
} from "@muhmdraouf/core/testing";

/** stream-json wire lines, shaped like the live stream (see test/fixtures/stream/). */
export const wire = {
  init: (sessionId: string, model = "glm-5.3"): string =>
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }),
  text: (text: string): string =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  tool: (name: string, input: Record<string, unknown>): string =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }),
  retry: (status: number | null, attempt = 1): string =>
    JSON.stringify({ type: "system", subtype: "api_retry", attempt, max_retries: 10, error_status: status }),
  result: (
    fields: { readonly report?: unknown; readonly isError?: boolean; readonly text?: string } = {},
  ): string =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: fields.isError ?? false,
      result: fields.text ?? "done",
      structured_output: fields.report ?? null,
      num_turns: 2,
      duration_ms: 1500,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
      },
    }),
};

/** The claude worker's dialect: stream-json lines, its caps, and its missing-session rule. */
export const CLAUDE_DIALECT: WorkerDialect = {
  caps: CLAUDE_CAPS,
  parseLine: (line) => {
    const parsed = parseStreamLine(line);
    return parsed.ok ? parsed.value : [];
  },
  init: wire.init,
  sessionMissing: claudeSessionMissing,
  fixtures: new URL("../fixtures/stream/", import.meta.url),
};

/** A completed run with a valid change report, its session announced by init. */
export function completes(report: unknown = VALID_CHANGE_REPORT): WorkerScript {
  return { lines: [wire.text("working"), wire.result({ report })] };
}

/** zai's host: the claude binary and the real key line. */
class ZaiHost extends FakeHost {
  override async extraChecks(): Promise<readonly SetupCheck[]> {
    return [keyCheck(ZAI_PROVIDER, keySource(this.keyResult))];
  }
}

/** core's fakes as zai: its provider, the claude dialect and its host. */
export function fakeDeps(
  scripts: WorkerScript[] = [completes()],
  env: Readonly<Record<string, string | undefined>> = {},
): Fakes {
  return coreFakeDeps(scripts, env, {
    provider: ZAI_PROVIDER,
    dialect: CLAUDE_DIALECT,
    host: (root) => new ZaiHost(root, ZAI_PROVIDER),
  });
}
