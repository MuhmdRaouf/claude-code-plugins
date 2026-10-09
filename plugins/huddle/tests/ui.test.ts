// UI: the static shell the server hands out — every asset the page loads is served, nothing
// points off-box, the compiled CSS carries the shared mocha/latte themes through daisyUI, and the
// bundled fonts answer with their type.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

import { startServer } from "./net";
let U = "";
const ROOT = `${import.meta.dir}/..`;
const PUB = `${ROOT}/plugin/server/public`;
let srv: Subprocess;

beforeAll(async () => {
  const s = await startServer({ HUDDLE_DATA: mkdtempSync(`${tmpdir()}/huddle-ui-`) });
  srv = s.p; U = s.u;
}, 40_000);
afterAll(async () => { srv.kill(); await srv.exited; }, 20_000);

test("(a) / is HTML that loads /static/app.css and /static/app.js", async () => {
  const r = await fetch(`${U}/`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/html");
  const html = await r.text();
  expect(html).toContain("/static/app.css");
  expect(html).toContain("/static/app.js");
  expect(html).toContain('<div id="app"></div>');
});

test("(b) the stylesheet and the app module answer 200 with the right type, on both path shapes", async () => {
  const css = await fetch(`${U}/static/app.css`);
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toContain("text/css");
  const js = await fetch(`${U}/static/app.js`);
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toContain("text/javascript");
  // the dashboard's own paths beside the fonts: same bytes, radar's shape
  for (const p of ["/app.js", "/app.css"]) {
    const r = await fetch(`${U}${p}`);
    expect(`${p}: ${r.status}`).toBe(`${p}: 200`);
    expect(r.headers.get("content-type")).toContain(p.endsWith(".css") ? "text/css" : "text/javascript");
  }
});

test("(c) the served HTML and JS point nowhere off-box: no http(s) URL beyond the w3.org namespace", async () => {
  const html = await (await fetch(`${U}/`)).text();
  const js = await (await fetch(`${U}/static/app.js`)).text();
  const urls = [...`${html}${js}`.matchAll(/https?:\/\/[^\s"'`)<]+/g)].map(m => m[0]);
  expect(urls.filter(u => !u.startsWith("http://www.w3.org/"))).toEqual([]);
});

test("(d) the compiled CSS is Catppuccin through the shared theme, with daisyUI's components", async () => {
  const css = (await (await fetch(`${U}/static/app.css`)).text()).toLowerCase();
  // Mocha base, mauve, blue, crust; Latte base, mauve, blue, text — the two themes, and no others
  for (const t of ["#1e1e2e", "#cba6f7", "#89b4fa", "#11111b", "#eff1f5", "#8839ef", "#1e66f5", "#4c4f69"]) expect(css).toContain(t);
  for (const t of ["#0b0f14", "#22d3ee", "#34d399"]) expect(css).not.toContain(t);
  // mocha is the default and the prefers-dark choice; latte rides [data-theme=latte]
  expect(css).toContain("prefers-color-scheme:dark");
  expect(css).toContain("[data-theme=latte]");
  // the components the pages are built from compiled in
  for (const t of [".btn{", ".badge{", ".menu{", ".card{", ".join{", ".stat{", ".skeleton{", ".kbd{"]) expect(css).toContain(t);
  // the fonts load from the bundle, never the network
  expect(css).not.toMatch(/url\((["']?)https?:\/\//);
  expect(css).toContain("url(/fonts/");
});

test("(e) every font the stylesheet names answers 200 as font/woff2; anything else is a 404", async () => {
  const css = await (await fetch(`${U}/static/app.css`)).text();
  const names = [...new Set([...css.matchAll(/url\((\/fonts\/[^)]+)\)/g)].map((m) => m[1]!.slice("/fonts/".length)))];
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    if (!name.endsWith(".woff2")) continue; // the .woff fallbacks ship only as woff2, like radar's
    const r = await fetch(`${U}/fonts/${name}`);
    expect(`${name}: ${r.status}`).toBe(`${name}: 200`);
    expect(r.headers.get("content-type")).toContain("font/woff2");
    expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  }
  expect((await fetch(`${U}/fonts/ibm-plex-mono-latin-400-normal.woff`)).status).toBe(404);
  expect((await fetch(`${U}/fonts/nope.woff2`)).status).toBe(404);
  expect((await fetch(`${U}/fonts/..%2Findex.html.woff2`)).status).toBe(404);
  expect((await fetch(`${U}/fonts/../../etc/passwd.woff2`)).status).toBe(404);
});
