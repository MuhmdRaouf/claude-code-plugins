import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Core's executable stand-in for `claude` (test/support/fake-claude.ts), for plugins that keep no copy of their own. */
export const FAKE_CLAUDE = join(import.meta.dirname, "fake-claude.ts");

/** The runtime tests start bundles, routers and CLIs with: `TEST_RUNTIME=bun` (resolved on PATH), an absolute path to
 *  a bun or node binary, or `node`/unset (this process's own node). The bundles must run unchanged on both, so the
 *  end-to-end and chaos suites run once per runtime. */
export function testRuntime(env: NodeJS.ProcessEnv = process.env): string {
  const wanted = env.TEST_RUNTIME;
  if (wanted === undefined || wanted === "" || wanted === "node") return process.execPath;
  if (wanted.startsWith("/")) return wanted;
  if (wanted !== "bun") throw new Error(`TEST_RUNTIME must be bun or node, not ${wanted}`);
  return execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
}
