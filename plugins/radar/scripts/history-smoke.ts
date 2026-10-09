/**
 * Smoke for the history storage layer, run under both Bun and Node: opens a history in a temp dir,
 * writes a root, a subagent and a request with content, reads everything back, and exits 0 only when
 * it all matches. Node runs this file through type stripping, so it sticks to erasable syntax and
 * .ts import specifiers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NodeUpsert, openHistory } from "../src/history/history.ts";
import { ZERO_TOKENS } from "../src/shared/model.ts";

const runtime = process.versions.bun === undefined ? "node" : "bun";

/** Throw unless got and want are identical JSON. */
function check(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label}: got ${g ?? "undefined"}, want ${w ?? "undefined"}`);
}

const dir = mkdtempSync(join(tmpdir(), "radar-history-smoke-"));
try {
  const h = await openHistory(join(dir, "history.db"));
  const root: NodeUpsert = {
    id: "s1/main",
    kind: "main",
    sessionId: "s1",
    agentId: "main",
    project: "app",
    cwd: "/work/app",
    startedAt: 100,
    lastAt: 9000,
  };
  h.upsertNode(root);
  h.upsertNode({
    id: "s1/ag",
    kind: "subagent",
    parentId: "s1/main",
    sessionId: "s1",
    agentId: "ag",
    label: "scout",
    lastAt: 8900,
  });
  h.putRequest("s1/main", {
    id: "r1",
    sessionId: "s1",
    agentId: "main",
    model: "glm-5.3-flash",
    upstream: "https://api.z.ai",
    ts: 9000,
    latencyMs: 120,
    tokens: { ...ZERO_TOKENS, input: 11, output: 7 },
    stopReason: "end_turn",
    provider: "zai",
  });
  h.putContent("r1", { input: "列表 request ✓", output: "réponse" });

  const roots = h.roots({ scope: "live", now: 10_000, liveMs: 5_000, limit: 10 });
  check(
    "roots",
    roots.map((r) => [r.id, r.requests, r.nodes, r.liveNodes, r.lastAt]),
    [["s1/main", 1, 2, 2, 9000]],
  );

  const nodes = h.tree("s1/main", { now: 10_000, liveMs: 5_000 });
  check(
    "tree",
    nodes.map((n) => [n.id, n.live]),
    [
      ["s1/main", true],
      ["s1/ag", true],
    ],
  );

  const requests = h.requestsOf({ rootId: "s1/main", limit: 10 });
  check(
    "requestsOf",
    requests.map((r) => r.id),
    ["r1"],
  );
  if (requests[0]?.tokens.input !== 11 || requests[0]?.tokens.output !== 7)
    throw new Error(`request tokens did not survive: ${JSON.stringify(requests[0]?.tokens)}`);

  const text = "列表 request ✓";
  check("content", h.content("r1"), {
    input: text,
    output: "réponse",
    bytes: Buffer.byteLength(text) + Buffer.byteLength("réponse"),
  });

  h.close();
  console.log(`history smoke ok (${runtime})`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
