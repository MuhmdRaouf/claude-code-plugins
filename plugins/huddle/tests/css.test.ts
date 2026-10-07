// CSS: the committed plugin/server/public/app.css must equal a fresh Tailwind build of the same
// sources (same command as `bun run css`), so a JS/HTML change that adds classes cannot ship
// without recompiling. HUDDLE_CSS_COMPARE_PATH points the comparison at another file (negative check).
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = `${import.meta.dir}/..`;
const COMMITTED = `${ROOT}/plugin/server/public/app.css`;

const build = async (): Promise<string> => {
  const out = `${mkdtempSync(`${tmpdir()}/huddle-css-`)}/app.css`;
  const p = Bun.spawn([`${ROOT}/node_modules/.bin/tailwindcss`, "-i", "plugin/server/public/src/app.css", "-o", out, "--minify"], { cwd: ROOT, stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`tailwindcss exited ${code}: ${err}`);
  return readFileSync(out, "utf8");
};

const selectors = (css: string) => new Set([...css.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => m[1]));

// null when identical, else a message listing the selectors that differ
const diff = (fresh: string, committed: string): string | null => {
  if (fresh === committed) return null;
  const f = selectors(fresh), c = selectors(committed);
  const missing = [...f].filter((s) => !c.has(s)).sort(), extra = [...c].filter((s) => !f.has(s)).sort();
  return [
    "plugin/server/public/app.css is stale: it differs from a fresh Tailwind build. Run `bun run css` and commit the result.",
    `selectors only in the fresh build (missing from the committed file): ${missing.length ? missing.map((s) => "." + s).join(" ") : "(none)"}`,
    `selectors only in the committed file: ${extra.length ? extra.map((s) => "." + s).join(" ") : "(none)"}`,
  ].join("\n");
};

test("the compiled stylesheet is current", async () => {
  const fresh = await build();
  const path = process.env.HUDDLE_CSS_COMPARE_PATH || COMMITTED;
  const msg = diff(fresh, readFileSync(path, "utf8"));
  if (msg) throw new Error(msg);
  expect(msg).toBeNull();
}, 60_000);

test("a truncated stylesheet is detected as stale", async () => {
  const fresh = await build();
  const tmp = `${mkdtempSync(`${tmpdir()}/huddle-css-trunc-`)}/app.css`;
  writeFileSync(tmp, fresh.slice(0, Math.floor(fresh.length * 0.8)));
  const msg = diff(fresh, readFileSync(tmp, "utf8"));
  expect(msg).not.toBeNull();
  expect(msg!).toContain("bun run css");
}, 60_000);
