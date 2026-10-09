// Dashboard: the committed plugin/server/public/{app.js,app.css,fonts} must equal a fresh Vite build
// of the same sources (the dashboard half of `bun run build`), so a UI change cannot ship without
// rebuilding what the server serves — the same byte-compare the plugin/dist bundles get.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
// @ts-ignore — a plain ES module
import { bundleApp } from "../scripts/build.mjs";

const ROOT = `${import.meta.dir}/..`;

test("the committed dashboard is a fresh build of the UI sources", async () => {
  const stale: string[] = [];
  for (const { fileName, contents } of await bundleApp()) {
    let committed: Buffer | null = null;
    try {
      committed = readFileSync(`${ROOT}/plugin/server/public/${fileName}`);
    } catch {}
    if (committed === null || !committed.equals(contents)) stale.push(fileName);
  }
  if (stale.length) throw new Error(`stale: ${stale.join(", ")} — run \`bun run build\` and commit plugin/server/public/`);
  expect(stale).toEqual([]);
}, 120_000);
