// UI: the static shell the server hands out — every asset the page loads is served, nothing
// points off-box, the compiled CSS carries the Catppuccin palettes, and every id the JS uses exists.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
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

// the module graph reachable from app.js through relative imports, as /static paths
const graph = (entry: string) => {
  const seen = new Set([entry]);
  const walk = (p: string) => {
    for (const m of readFileSync(`${PUB}/${p}`, "utf8").matchAll(/(?:from|import)\s*"(\.\/[^"]+)"/g)) {
      const q = new URL(m[1], `http://x/${p}`).pathname.slice(1);
      if (!seen.has(q)) { seen.add(q); walk(q); }
    }
  };
  walk(entry);
  return [...seen];
};
const JS = graph("app.js");

test("(a) / is HTML that loads /static/app.css and /static/app.js", async () => {
  const r = await fetch(`${U}/`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/html");
  const html = await r.text();
  expect(html).toContain("/static/app.css");
  expect(html).toContain("/static/app.js");
});

test("(b) the stylesheet and every module the page imports answer 200 with the right type", async () => {
  const css = await fetch(`${U}/static/app.css`);
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toContain("text/css");
  for (const p of JS) {
    const j = await fetch(`${U}/static/${p}`);
    expect(`${p}: ${j.status}`).toBe(`${p}: 200`);
    expect(j.headers.get("content-type")).toContain("text/javascript");
  }
});

test("(c) the served HTML and JS point nowhere off-box: no http(s) URL beyond the w3.org namespace", async () => {
  const html = await (await fetch(`${U}/`)).text();
  const js = await Promise.all(JS.map(async p => await (await fetch(`${U}/static/${p}`)).text()));
  const urls = [...`${html}${js.join("")}`.matchAll(/https?:\/\/[^\s"'`)<]+/g)].map(m => m[0]);
  expect(urls.filter(u => !u.startsWith("http://www.w3.org/"))).toEqual([]);
});

test("(d) the compiled CSS is Catppuccin: Mocha for dark, Latte for light, nothing of the old headroom palette", async () => {
  const css = (await (await fetch(`${U}/static/app.css`)).text()).toLowerCase();
  // Mocha base, mauve, blue, crust; Latte base, mauve, blue, text
  for (const t of ["#1e1e2e", "#cba6f7", "#89b4fa", "#11111b", "#eff1f5", "#8839ef", "#1e66f5", "#4c4f69"]) expect(css).toContain(t);
  for (const t of ["#0b0f14", "#22d3ee", "#34d399"]) expect(css).not.toContain(t);
  // both flavours follow the system and a chosen theme, and components read semantic tokens
  expect(css).toContain("prefers-color-scheme:dark");
  expect(css).toContain("[data-theme=dark]");
  for (const t of ["--bg:", "--panel:", "--panel-2:", "--border:", "--text:", "--muted:", "--primary:", "--success:", "--warning:", "--danger:", "--info:"]) expect(css).toContain(t);
});

test("(e) every id the JS relies on exists in index.html or a module", () => {
  const ids = ("addsec announce bnav cbody cdlg cf-desc cf-hand cf-members cf-orch cf-profile cf-repo cf-start cf-title " +
    "chbox chbtn chlist chname csave cx cx-inv cx-invite dlg-msg dlg-title edcancel ederr edsave edta ginfo gnote " +
    "help ib-clear imp kb-body kb-cancel kb-err kb-kind kb-tags kb-task kb-title kbadd kbf kblist kbq ldot main mbody " +
    "mclose modal mtitle nc-cancel nc-desc nc-err nc-members nc-name nc-title nch newch nodedesc older owner-sel pal " +
    "palbtn palkbd palq palres popmenu rbody ro-n roster sd-acts sd-brief sd-bsend sd-close sd-comp sd-ev sd-head " +
    "sd-kids sd-meta sd-now sd-orch sdrawer set-notif set-reset side stnote td-close tdrawer theme tl tlnew tls toasts " +
    "wfilters wfound wnew wown wpanel wph wq").split(" ");
  const hay = readFileSync(`${PUB}/index.html`, "utf8") +
    readdirSync(PUB).filter(f => f.endsWith(".js")).map(f => readFileSync(`${PUB}/${f}`, "utf8")).join("");
  expect(ids.filter(id => !hay.includes(id))).toEqual([]);
});
