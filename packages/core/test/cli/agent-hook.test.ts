import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  agentRun,
  agentStopMessage,
  modelAgentOf,
  readStdinWithin,
  readTail,
  transcriptPathOf,
} from "../../src/cli/agent-hook.ts";
import { agentStopHook } from "../../src/cli/commands/queries.ts";
import { EXIT } from "../../src/cli/exit.ts";
import { recordSetupDone } from "../../src/cli/route.ts";
import { runCli } from "../../src/cli/run.ts";
import { type Fakes, fakeDeps } from "../support/fakes.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";

function assistant(id: string, model: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: "assistant", message: { id, model, usage, content: [] } });
}

const GLM_RUN = [
  JSON.stringify({ type: "user", message: { content: "do it" } }),
  assistant("m1", "glm-5.3", { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 9000 }),
  // The same message streamed twice (one entry per content block): counted once.
  assistant("m1", "glm-5.3", { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 9000 }),
  assistant("m2", "glm-5.3", { input_tokens: 500, output_tokens: 50, cache_creation_input_tokens: 2000 }),
  "not json",
].join("\n");

const SONNET_RUN = assistant("m1", "claude-sonnet-4-6", { input_tokens: 10, output_tokens: 10 });

function transcript(fakes: Fakes, text: string): string {
  const path = join(fakes.root, "agent.jsonl");
  writeFileSync(path, text);
  return path;
}

async function hook(fakes: Fakes, input: unknown): Promise<string[]> {
  fakes.out.lines.length = 0;
  expect(await agentStopHook({ deps: fakes.deps } as never, JSON.stringify(input))).toBe(EXIT.ok);
  return fakes.out.lines.map((line) => (JSON.parse(line) as { systemMessage: string }).systemMessage);
}

describe("the SubagentStop hook", () => {
  it("knows only this plugin's model agents, with or without the plugin prefix", () => {
    expect(modelAgentOf(REFERENCE_PROVIDER, { agent_type: "zai:glm-5.3" })).toBe("glm-5.3");
    expect(modelAgentOf(REFERENCE_PROVIDER, { agent_type: "glm-5.3-flash" })).toBe("glm-5.3-flash");
    expect(modelAgentOf(REFERENCE_PROVIDER, { agent_type: "zai:omp" })).toBeUndefined();
    expect(modelAgentOf(REFERENCE_PROVIDER, { agent_type: "Explore" })).toBeUndefined();
    expect(modelAgentOf(REFERENCE_PROVIDER, {})).toBeUndefined();
  });

  it("finds the agent's transcript: the given path, else beside the session's", () => {
    expect(transcriptPathOf({ agent_transcript_path: "/t/agent.jsonl" })).toBe("/t/agent.jsonl");
    expect(transcriptPathOf({ transcript_path: "/p/s1.jsonl", session_id: "s1", agent_id: "a1" })).toBe(
      "/p/s1/subagents/agent-a1.jsonl",
    );
    expect(transcriptPathOf({ transcript_path: "/p/s1.jsonl" })).toBeUndefined();
  });

  it("folds the transcript: models, one request per message id, the tokens", () => {
    expect(agentRun(GLM_RUN)).toEqual({
      models: ["glm-5.3"],
      requests: 2,
      inputTokens: 1500,
      outputTokens: 150,
      cacheReadTokens: 9000,
      cacheWriteTokens: 2000,
    });
    expect(agentRun("").models).toEqual([]);
  });

  it("on the provider's model: what it ran on, its tokens and the estimated cost", () => {
    expect(agentStopMessage(REFERENCE_PROVIDER, "glm-5.3", agentRun(GLM_RUN), true)).toBe(
      "zai:glm-5.3 ran on glm-5.3 via the zai router: 2 requests, 12.5k in / 150 out, est. $0.0051.",
    );
  });

  it("on Sonnet: why, and the slash command that fixes it", () => {
    const run = agentRun(SONNET_RUN);

    expect(agentStopMessage(REFERENCE_PROVIDER, "glm-5.3", run, true)).toBe(
      "zai:glm-5.3 ran on Sonnet: the zai router was down; run /zai:setup.",
    );
    expect(agentStopMessage(REFERENCE_PROVIDER, "glm-5.3", run, false)).toBe(
      "zai:glm-5.3 ran on Sonnet: zai is not set up yet; run /zai:setup.",
    );
    expect(agentStopMessage(REFERENCE_PROVIDER, "glm-5.3", agentRun(""), true)).toBeUndefined();
  });

  it("speaks to the user only (a systemMessage), and stays silent on anything it cannot read", async () => {
    const fakes = fakeDeps();
    recordSetupDone(fakes.root);
    const path = transcript(fakes, SONNET_RUN);

    expect(await hook(fakes, { agent_type: "zai:glm-5.3", agent_transcript_path: path })).toEqual([
      "zai:glm-5.3 ran on Sonnet: the zai router was down; run /zai:setup.",
    ]);
    expect(await hook(fakes, { agent_type: "Explore", agent_transcript_path: path })).toEqual([]);
    expect(await hook(fakes, { agent_type: "zai:glm-5.3", agent_transcript_path: "/nope.jsonl" })).toEqual(
      [],
    );
    fakes.out.lines.length = 0;
    expect(await agentStopHook({ deps: fakes.deps } as never, "not json")).toBe(EXIT.ok);
    expect(fakes.out.lines).toEqual([]);
  });

  it("`usage --hook` is the command the hooks file runs; it skips the workspace cleanup", async () => {
    const fakes = fakeDeps();
    expect(await runCli(["usage", "--hook"], fakes.deps, "/repo")).toBe(EXIT.ok);
  });

  it("reads only the transcript's tail, from a whole line", () => {
    const fakes = fakeDeps();
    mkdirSync(fakes.root, { recursive: true });
    const path = transcript(fakes, `${"x".repeat(100)}\n${SONNET_RUN}\n`);

    expect(readTail(path, SONNET_RUN.length + 5)).toBe(`${SONNET_RUN}\n`);
    expect(readTail(path)).toBe(readFileSync(path, "utf8"));
    expect(readTail(join(fakes.root, "missing"))).toBeUndefined();
  });

  it("never waits on stdin longer than its budget", async () => {
    const open = new PassThrough();
    open.write("{");
    const started = Date.now();

    expect(await readStdinWithin(50, open)).toBe("{");
    expect(Date.now() - started).toBeLessThan(1000);

    const closed = new PassThrough();
    closed.end('{"a":1}');
    expect(await readStdinWithin(5000, closed)).toBe('{"a":1}');
  });
});
