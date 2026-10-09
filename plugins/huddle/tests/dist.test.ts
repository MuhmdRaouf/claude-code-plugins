// dist: every launch line (hooks.json, .mcp.json, the commands, bin/huddle) runs plugin/dist/, so the
// committed bundles must equal a fresh build of the TypeScript sources (`bun run build`), and no
// source may lean on a Bun-only API outside the runtime layer (src/rt.ts): Node runs the same files.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore — a plain ES module
import { bundles, ENTRIES } from "../scripts/build.mjs";

const ROOT = `${import.meta.dir}/..`;

test("the committed plugin/dist/ is a fresh build of the sources", async () => {
  const stale: string[] = [];
  for (const [file, text] of await bundles()) {
    let committed = "";
    try { committed = readFileSync(`${ROOT}/${file}`, "utf8"); } catch {}
    if (committed !== text) stale.push(file);
  }
  if (stale.length) throw new Error(`stale: ${stale.join(", ")} — run \`bun run build\` and commit plugin/dist/`);
  expect(stale).toEqual([]);
  expect(readdirSync(`${ROOT}/plugin/dist`).sort()).toEqual([...Object.keys(ENTRIES).map(n => `${n}.js`), "package.json"].sort());
}, 60_000);

test("only src/rt.ts touches Bun: every other source runs on Node as well", () => {
  const hits: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) { if (!["public", "dist", "local"].includes(n)) walk(f); continue; }
    if (!f.endsWith(".ts") || f.endsWith("/src/rt.ts")) continue;
    readFileSync(f, "utf8").split("\n").forEach((l, i) => { if (/\bBun\.|from "bun"|"bun:|import\.meta\.(dir|path)\b/.test(l)) hits.push(`${f.slice(ROOT.length + 1)}:${i + 1}`); });
  } };
  walk(`${ROOT}/plugin`);
  expect(hits).toEqual([]);
});

test("every launch line runs a bundle through bun, else node", () => {
  const mcp = JSON.parse(readFileSync(`${ROOT}/plugin/.mcp.json`, "utf8")).mcpServers.huddle;
  expect(mcp).toEqual({ command: "sh", args: ["${CLAUDE_PLUGIN_ROOT}/bin/huddle-mcp"] });
  for (const n of ["huddle", "huddle-mcp"]) {
    const sh = readFileSync(`${ROOT}/plugin/bin/${n}`, "utf8");
    expect(sh).toContain("command -v bun || command -v node");
    expect(sh).toContain(`/dist/${n}.js`);
  }
  for (const c of readdirSync(`${ROOT}/plugin/commands`)) {
    const md = readFileSync(`${ROOT}/plugin/commands/${c}`, "utf8");
    expect(md, c).not.toMatch(/\bbun "|huddle\.ts/);
    expect(md, c).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/huddle"');
  }
});
