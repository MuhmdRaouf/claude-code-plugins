// Huddle — a local coordination service for AI coding sessions. Sessions in the same channel
// (each in its own project, or a subagent of one) share one event stream, one plan of tasks
// that can depend on each other, the owner's pause and messages, and a shared knowledge store.
// Each channel is its own SQLite file;
// this process is its only writer, and wakes the sessions that wait on it.
//
//   UI       GET /                                  the owner's control room
//   API      GET /api/channels · POST /api/channels {name, …config}
//            POST /api/c/<ch>/op/<op>?as=<session>  every operation (src/ops.ts); blocking ops long-poll
//            GET  /api/c/<ch>[/board|/sessions|/timeline[?after=seq]|/task/<id>|/search|/review|/plan.json|/export.md|/kb]
//            GET  /api/c/<ch>/conflicts · /knowledge.md[?verified=1]   files two sessions edit · knowledge for CLAUDE.md
//            GET  /api/c/<ch>/live[?as=<session>]   SSE: events, presence, tasks, control
//            GET  /api/c/<ch>/repo/<view>           repo views for a channel with a repo (src/ext)
//            /api/c/<ch>/x/{rules,approval,approvals,radar,digest} · /api/settings   src/extras.ts
//   MCP      POST /mcp/<ch>?as=<session>            Streamable HTTP; tools = src/ops.ts
//   health   GET /health
//   join     POST /api/join {token, name}               an invite for a session credential (src/auth.ts)
//            /api/tokens[/<id>] · /api/members[/<name>] · POST /api/login (any session) · GET /api/whoami
// Every other /api and /mcp request needs a credential (src/auth.ts): header x-huddle-token, or
// the cookie a browser gets from a one-time /?code=<login code>. Members, roots, browsers and unused
// invites persist as digests in $HUDDLE_DATA/auth.json (0600; src/auth.ts), so a restart keeps everyone in.
// Env: PORT (no fixed default: unset, a random free five-digit one, src/port.ts; 0 = any free port, the
//      one bound is printed; `huddle up` passes the port saved for its home), HUDDLE_DATA ($HUDDLE_HOME/data, HUDDLE_HOME ./.agents/huddle: SQLite channels/<name>.db),
//      HUDDLE_HOSTS (extra allowed Host headers; 127.0.0.1:PORT and localhost:PORT always are), HUDDLE_AUTO_CREATE (1).
import { Hub } from "./src/hub";
import { HuddleError, OWNER, NAME_RE, type Channel, type Row } from "./src/channel";
import { runOp } from "./src/ops";
import { mcpHandle } from "./src/mcp";
import { watchRemoval, removeRunFiles, writeLeftBehind } from "./src/lifecycle";
import * as K from "./src/knowledge";
import { conflicts } from "./src/touches";
import { repoRoute, diagramFile, exportMd, viewNames } from "./src/ext/views";
import { Auth, given, mayAct, type Who } from "./src/auth";
import { randomPort } from "./src/port";
import * as X from "./src/extras";
import { Notifier } from "./src/notify";
import { PLUGIN, serve, sleep, stdinText } from "./src/rt";
import { readFile } from "node:fs/promises";
import { existsSync, rmSync, statSync } from "node:fs";

const ROOT = `${PLUGIN}/server`; // public/ and CONNECT.md, also when this runs bundled from dist/
let PORT = process.env.PORT ? Number(process.env.PORT) : await randomPort();
const HOME = process.env.HUDDLE_HOME || `${process.cwd()}/.agents/huddle`;
const DATA = process.env.HUDDLE_DATA || `${HOME}/data`;
// the root credential: HUDDLE_TOKEN, else the first line on stdin (`huddle up` hands it over so it
// never sits in a file or the environment), else a fresh one shown only on a terminal
const ROOT_CRED = process.env.HUDDLE_TOKEN
  || (process.env.HUDDLE_ROOT_STDIN === "1" ? (await stdinText().catch(() => "")).split("\n")[0].trim() : "")
  || crypto.randomUUID() + crypto.randomUUID();
const AUTH_FILE = `${DATA}/auth.json`;
const AUTH = new Auth(ROOT_CRED, Date.now, s => console.log(`huddle: ${s}`), AUTH_FILE);
let COOKIE = `huddle_session_${PORT}`; // one per port: browsers do not scope cookies by port
const hub = new Hub(DATA, process.env.HUDDLE_AUTO_CREATE !== "0");
const STARTED = new Date().toISOString();
// what needs the owner notifies the desktop as it happens (src/extras.ts, src/notify.ts)
const NOTIFY = new Notifier(DATA);
X.watchHub(hub, NOTIFY);
// the plugin's version (.claude-plugin/plugin.json, beside this server in the installed plugin)
const VERSION = (await readFile(`${PLUGIN}/.claude-plugin/plugin.json`, "utf8").then(JSON.parse).catch(() => ({}))).version ?? "dev";

// Only this machine's browser and sessions may use Huddle. A page in another tab can send simple
// cross-site requests and a rebound DNS name can reach 127.0.0.1, so: the Host must be ours, and
// every write must carry content-type: application/json (impossible cross-site without a
// preflight we never answer) and, if present, our Origin.
// Loopback names for our own port are always allowed (a rebinding attack arrives with its own
// hostname); HUDDLE_HOSTS adds the rest.
const EXTRA_HOSTS = (process.env.HUDDLE_HOSTS ?? "").split(",").map(s => s.trim()).filter(Boolean);
let HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...EXTRA_HOSTS]);
function guard(req: Request): Response | null {
  if (!HOSTS.has(req.headers.get("host") ?? "")) return new Response("wrong host", { status: 421 });
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
  const origin = req.headers.get("origin");
  if (origin && !HOSTS.has(origin.replace(/^https?:\/\//, ""))) return new Response("cross-origin write refused", { status: 403 });
  if (req.method !== "DELETE" && !(req.headers.get("content-type") ?? "").startsWith("application/json")) return new Response("writes need content-type: application/json", { status: 415 });
  return null;
}

const json = (o: unknown, status = 200, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...h } });
const STATIC: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8" };
const who = (req: Request, u: URL) => u.searchParams.get("as") ?? req.headers.get("x-huddle-as") ?? "";

/** The bundled IBM Plex faces the dashboard's stylesheet points at. The name is one allowlisted
 *  file name — the regex admits no "/", so the path can never leave fonts/ — and only .woff2 ships. */
async function fontRoute(path: string): Promise<Response> {
  const name = path.slice("/fonts/".length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.woff2$/.test(name)) return json({ error: `not found: ${path}` }, 404);
  try {
    return new Response(await readFile(`${ROOT}/public/fonts/${name}`), {
      headers: { "content-type": "font/woff2", "cache-control": "no-store" },
    });
  } catch {
    return json({ error: `missing build artifact: fonts/${name}` }, 404);
  }
}

// what someone without a (working) credential is told: a session (it sends x-huddle-token) gets
// a recovery step; a browser gets {signin: true}, and the dashboard shows its "Signed out" page
const SESSION_401 = "not in this huddle: this session holds no credential for it. In a session that is in it, run /huddle:invite and paste the join line it shows into this session (/huddle:join …)";
const SIGNED_OUT = "This browser is not signed in to Huddle (its sign-in ended, or the link expired). Run `huddle open` in a terminal of this project, or /huddle:setup in a Claude session there, and open the new link.";
// the page a used or expired sign-in link lands on: the dashboard's sign-in card (logo, name, one
// card with what to run, the version under it), self-contained, in Catppuccin Latte or Mocha
const LOGO_SVG = `<svg viewBox="0 0 26 26" width="36" height="36" aria-hidden="true"><path d="M5 17 Q13 2 21 17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.2 2.2" opacity=".75"/><circle cx="13" cy="9.6" r="2.4" fill="currentColor"/><rect x="2.5" y="17" width="5" height="6" rx="2.5" fill="currentColor"/><rect x="18.5" y="17" width="5" height="6" rx="2.5" fill="currentColor"/></svg>`;
const signedOutPage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Huddle: signed out</title>
<script>try{const t=JSON.parse(localStorage.getItem("huddle:theme")||"null");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}</script>
<style>
:root{--bg:#e6e9ef;--panel:#eff1f5;--border:#ccd0da;--border2:#bcc0cc;--text:#4c4f69;--muted:#5c5f77;--faint:#5f627a;--blue:#1e66f5;--blueink:#2e5ec4;--peach:#fe640b;--peachink:#8a5648;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#181825;--panel:#1e1e2e;--border:#313244;--border2:#45475a;--text:#cdd6f4;--muted:#a6adc8;--faint:#9399b2;--blue:#89b4fa;--blueink:#89b4fa;--peach:#fab387;--peachink:#fab387;color-scheme:dark}}
:root[data-theme=dark]{--bg:#181825;--panel:#1e1e2e;--border:#313244;--border2:#45475a;--text:#cdd6f4;--muted:#a6adc8;--faint:#9399b2;--blue:#89b4fa;--blueink:#89b4fa;--peach:#fab387;--peachink:#fab387;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:28rem;display:flex;flex-direction:column;gap:32px}.head{text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px}
.logo{display:inline-flex;width:64px;height:64px;align-items:center;justify-content:center;border-radius:16px;color:var(--blueink);background:color-mix(in srgb,var(--blue) 14%,var(--panel));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--blue) 30%,transparent)}
h1{margin:0;font-size:30px;font-weight:700;letter-spacing:-.02em}.sub{margin:0;color:var(--muted);font-size:15px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:24px;display:flex;flex-direction:column;gap:16px}
.note{display:flex;gap:10px;align-items:flex-start;border:1px solid color-mix(in srgb,var(--peach) 30%,var(--panel));background:color-mix(in srgb,var(--peach) 9%,var(--panel));border-radius:8px;padding:12px;font-size:13px}
.note b{font-weight:600}.note span{color:var(--muted)}.note i{color:var(--peachink);font-style:normal;font-weight:700}
p{margin:0}.muted{color:var(--muted);font-size:13px}.lab{font-size:13px;font-weight:500;margin-bottom:6px}
.field{display:flex;align-items:center;gap:10px;height:40px;padding:0 12px;border:1px solid var(--border2);border-radius:8px;background:var(--bg);font:13px ui-monospace,"SF Mono",Menlo,monospace}
.field::before{content:"›_";color:var(--faint);font-weight:600}
footer{text-align:center;font-size:12px;color:var(--faint)}
</style></head>
<body><main><div class="head"><span class="logo">${LOGO_SVG}</span><h1>Huddle</h1><p class="sub">Sign in to see your channels and sessions</p></div>
<section class="card"><div class="note" role="status"><i aria-hidden="true">!</i><p><b>Signed out.</b> <span>This sign-in link was used or has expired: each link signs in one browser, once.</span></p></div>
<p class="muted">Get a new link from any session in this huddle, then open it here.</p>
<div><div class="lab">In a Claude session</div><div class="field">/huddle:setup</div></div>
<div><div class="lab">Or in a terminal</div><div class="field">huddle open</div></div></section>
<footer>Huddle v${VERSION}</footer></main></body></html>`;

// SSE: every live message of a channel; with ?as=<session>, the events of everyone else (every
// member sees every message, also those addressed to another session). A self-removal closes every
// open stream through `streams` (src/lifecycle.ts), so a dashboard learns the server is going.
const streams = new Set<() => void>();
function live(ch: Channel, as: string, last: number) {
  const enc = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream({
    start(c) {
      const send = (o: unknown) => { try { c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`)); } catch { stop(); } };
      c.enqueue(enc.encode(`retry: 3000\ndata: ${JSON.stringify({ ch: ch.name, type: "hello", data: { last } })}\n\n`));
      const off = ch.subscribe(m => {
        if (as && as !== OWNER) {
          if (m.type !== "event") return;
          const e = m.data;
          if (e.from === as) return;
        }
        send(m);
      });
      const ka = setInterval(() => { try { c.enqueue(enc.encode(": ping\n\n")); } catch { stop(); } }, 15_000);
      stop = () => { off(); clearInterval(ka); streams.delete(stop); try { c.close(); } catch {} };
      streams.add(stop);
    },
    cancel() { stop(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
}

// a body as the channel will keep it: no credential, code or invite of this run in it
async function body(req: Request): Promise<Row> {
  if (req.method !== "POST" && req.method !== "PATCH") return {};
  const t = await req.text();
  if (!t) return {};
  let v: Row;
  try { v = JSON.parse(t); } catch { throw new HuddleError(400, "body is not JSON"); }
  return AUTH.redact(v);
}

// who may join and how: invites (root, or a member whose invite let it invite), members (root),
// and dashboard logins: any session with a credential, root or member, for its own browser (a
// browser does not mint more; a member's browser gets no admin rights, src/auth.ts)
async function adminRoute(req: Request, path: string, me: Who): Promise<Response | null> {
  const rootOnly = () => me.root ? null : json({ error: "only the session that started Huddle may do this" }, 403);
  if (path === "/api/whoami") return json(me);
  if (path === "/api/tokens" && req.method === "POST") {
    if (!me.invite) return json({ error: "this credential may not invite" }, 403);
    const b = await body(req);
    const ttl = b.ttl === undefined ? undefined : Number(b.ttl);
    if (ttl !== undefined && !(Number.isFinite(ttl) && ttl >= 0)) return json({ error: "ttl: seconds, 0 = never expires" }, 400);
    return json(AUTH.create({ ttl, single: !!b.single_use, invite: !!b.can_invite && me.root, channel: typeof b.channel === "string" ? b.channel : undefined,
      description: typeof b.description === "string" ? b.description.slice(0, 200) : undefined, by: me.name }));
  }
  if (path === "/api/tokens" && req.method === "GET") return rootOnly() ?? json(AUTH.list());
  let m = /^\/api\/tokens\/([a-z0-9]{6})$/.exec(path);
  if (m && req.method === "DELETE") return rootOnly() ?? (AUTH.revoke(m[1]) ? json({ deleted: m[1] }) : json({ error: `no token ${m[1]}` }, 404));
  if (path === "/api/members" && req.method === "GET") return rootOnly() ?? json(AUTH.memberList());
  m = /^\/api\/members\/([a-z][a-z0-9_-]{0,31})$/.exec(path);
  if (m && req.method === "DELETE") return rootOnly() ?? (AUTH.kick(m[1]) ? json({ kicked: m[1] }) : json({ error: `no member ${m[1]}` }, 404));
  if (path === "/api/login" && req.method === "POST") {
    if (me.browser) return json({ error: "a browser does not sign in other browsers: run huddle open (or /huddle:setup) in a session" }, 403);
    return json({ code: AUTH.loginCode(me.root ? null : me.name), expires_in: 300 });
  }
  return null;
}

async function channelRoute(req: Request, u: URL, name: string, rest: string): Promise<Response> {
  const ch = await hub.get(name, false);
  const as = who(req, u);
  if (rest === "") return json({ name, config: ch.config(), stats: await ch.stats(), turn: await ch.turn(), views: viewNames(ch) });
  let m = /^op\/([a-z_]+)$/.exec(rest);
  if (m && req.method === "POST") {
    if (!as) throw new HuddleError(400, "say who you are: ?as=<session> or header x-huddle-as");
    const b = await body(req);
    const { result, text } = await runOp(m[1], ch, as, b, { signal: req.signal, waitDefault: 240 });
    if (m[1] === "join" && b.claude_session) await X.link(ch, as, b.claude_session); // Radar's session ids → Huddle names
    return json({ result, text });
  }
  if (rest === "live") return live(ch, as, await ch.lastSeq());
  if (rest === "board") return json({ phases: await ch.phases(), steps: await ch.tasks(), meta: { ...ch.config(), fts: ch.fts, plan_at: ch.meta("plan_at") } });
  if (rest === "sessions") return json({ sessions: await ch.sessions(), turn: await ch.turn(), config: ch.config() });
  if (rest === "timeline") return json(await ch.events({ limit: Number(u.searchParams.get("limit") ?? 300), after: Number(u.searchParams.get("after") ?? 0), before: u.searchParams.get("before") ? Number(u.searchParams.get("before")) : undefined, topic: u.searchParams.get("topic") ?? undefined }));
  if (rest === "search") return json(await ch.search(u.searchParams.get("q") ?? ""));
  if (rest === "review") return json(await ch.review());
  if (rest === "attention") return json(await ch.attention());
  if (rest === "kb") return json(await K.recall(ch, u.searchParams.get("q") ?? "", { kind: u.searchParams.get("kind") ?? undefined, limit: Number(u.searchParams.get("limit") ?? 50) }));
  if ((m = /^kb\/(\d+)$/.exec(rest))) return json(await K.kb(ch, Number(m[1])));
  if (rest === "knowledge.md") return new Response(await K.exportMarkdown(ch, { verified: /^(1|true)$/.test(u.searchParams.get("verified") ?? "") }), { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
  if (rest === "conflicts") return json(await conflicts(ch));
  if ((m = /^task\/([\w.-]{1,32})$/.exec(rest))) { const t = await ch.task(m[1]); return t ? json(t) : json({ error: "no such task" }, 404); }
  if (rest === "plan.json") return json({ meta: ch.config(), phases: await ch.phases(), steps: await Promise.all((await ch.tasks()).map(t => ch.task(t.id))) });
  if (rest === "export.md") return new Response(await exportMd(ch), { headers: { "content-type": "text/markdown; charset=utf-8" } });
  if ((m = /^repo\/([a-z]+)$/.exec(rest))) return json(await repoRoute(ch, m[1], u));
  if (rest === "diagram") {
    const f = diagramFile(ch, u.searchParams.get("name") ?? "");
    return f ? new Response(await readFile(f), { headers: { "content-type": "image/png" } }) : new Response("bad", { status: 400 });
  }
  if ((m = /^x\/([a-z/]+)$/.exec(rest))) { const r = await X.route(ch, m[1], req, u, as, () => body(req)); if (r !== null) return json(r); }
  return json({ error: "not found" }, 404);
}

async function handle(req: Request): Promise<Response> {
    const bad = guard(req); if (bad) return bad;
    const u = new URL(req.url);
    const path = u.pathname;
    // the browser's sign-in: a one-time code becomes a cookie only this origin sends (gone with
    // the server), then the clean URL, so the code leaves the address bar
    if (path === "/" && u.searchParams.has("code")) {
      const cred = AUTH.redeem(u.searchParams.get("code") ?? "");
      if (!cred) return new Response(signedOutPage(), { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      u.searchParams.delete("code");
      return new Response(null, { status: 303, headers: { location: `/${u.search}`, "cache-control": "no-store",
        "set-cookie": `${COOKIE}=${encodeURIComponent(cred)}; Path=/; HttpOnly; SameSite=Strict` } });
    }
    if (path === "/api/join" && req.method === "POST") {
      const b = await req.json().catch(() => ({})) as Row; // raw: body() would redact the token it carries
      let name = String(b.name ?? "");
      if (!NAME_RE.test(name) || name.includes(".") || name === OWNER) return json({ error: `name must match ${NAME_RE} (no subagent, not owner)` }, 400);
      // unique: the name is only a wish (the joiner did not choose it, e.g. the project's name, which
      // the session that set the project up already uses): one no member and no session of the
      // channel holds, name-2, name-3, …
      const p = b.unique ? AUTH.peek(String(b.token ?? "")) : null;
      if (p) {
        const ch = p.channel ?? (typeof b.channel === "string" ? b.channel : "");
        const taken = new Set([...p.members, OWNER]);
        if (ch) try { if (await hub.exists(ch)) for (const s of await (await hub.get(ch, false)).sessions()) taken.add(String(s.name)); } catch {}
        for (let i = 2, base = name.slice(0, 28); taken.has(name); i++) name = `${base}-${i}`;
      }
      const r = AUTH.join(String(b.token ?? ""), name);
      return "error" in r ? json({ error: "invalid or expired join token: ask the owner for a new join command" }, 401) : json(r);
    }
    let me: Who | null = null;
    if (path.startsWith("/api/") || path === "/mcp" || path.startsWith("/mcp/")) {
      me = AUTH.who(given(req, COOKIE));
      if (!me) return req.headers.get("x-huddle-token") ? json({ error: SESSION_401 }, 401) : json({ error: SIGNED_OUT, signin: true }, 401);
      const as = who(req, u);
      if (as && !mayAct(me, as)) return json({ error: `this credential is ${me.name}'s: it acts as ${me.name} or ${me.name}.<role>, not ${as}` }, 403);
    }
    try {
      if (me && path === "/api/settings") return json(await X.settings(req, NOTIFY, me, () => body(req)));
      if (me && path.startsWith("/api/") && !path.startsWith("/api/c/")) { const r = await adminRoute(req, path, me); if (r) return r; }
      if (path === "/health") return json({ ok: true, version: VERSION, started: STARTED, channels: (await hub.names()).length });
      if (path === "/" || path === "/index.html") return new Response(await readFile(`${ROOT}/public/index.html`), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (path.startsWith("/static/") && !path.includes("..")) {
        const f = `${ROOT}/public/${path.slice(8)}`;
        if (existsSync(f) && statSync(f).isFile()) return new Response(await readFile(f), { headers: { "content-type": STATIC[path.slice(path.lastIndexOf("."))] ?? "text/plain", "cache-control": "no-store" } });
        return new Response("not found", { status: 404 });
      }
      // the dashboard's own paths: app.js and app.css beside the fonts the stylesheet points at
      if (path === "/app.js" || path === "/app.css") {
        const f = `${ROOT}/public${path}`;
        if (existsSync(f) && statSync(f).isFile()) return new Response(await readFile(f), { headers: { "content-type": STATIC[path.slice(path.lastIndexOf("."))], "cache-control": "no-store" } });
        return new Response("not found", { status: 404 });
      }
      if (path.startsWith("/fonts/")) return fontRoute(path);
      if (path === "/connect.md") return new Response(await readFile(`${ROOT}/CONNECT.md`), { headers: { "content-type": STATIC[".md"] } });
      if (path === "/api/channels" && req.method === "GET") return json(await hub.list());
      if (path === "/api/channels" && req.method === "POST") {
        const b = await body(req);
        if (await hub.exists(String(b.name ?? ""))) throw new HuddleError(409, `channel ${b.name} exists`);
        const ch = await hub.get(String(b.name ?? ""), true);
        const { name: _n, ...cfg } = b;
        return json({ name: ch.name, config: await ch.configure(cfg) });
      }
      let m = /^\/api\/c\/([a-z0-9-]{1,40})(?:\/(.*))?$/.exec(path);
      if (m) {
        // a session's first op may create the channel (join); everything else needs it to exist
        if (/^op\/join$/.test(m[2] ?? "") && hub.autoCreate && !(await hub.exists(m[1]))) await hub.get(m[1], true);
        return await channelRoute(req, u, m[1], m[2] ?? "");
      }
      m = /^\/mcp\/([a-z0-9-]{1,40})$/.exec(path);
      if (m || path === "/mcp") {
        const channel = m?.[1] ?? u.searchParams.get("channel") ?? req.headers.get("x-huddle-channel") ?? "";
        const as = who(req, u);
        if (!channel || !as) return json({ error: "use /mcp/<channel>?as=<session>" }, 400);
        if (req.method === "GET") return new Response("this endpoint answers POST; pushes come from bin/huddle-mcp", { status: 405 });
        if (req.method === "DELETE") return new Response(null, { status: 204 });
        if (hub.autoCreate && !(await hub.exists(channel))) await hub.get(channel, true);
        const msg = await body(req);
        const batch = Array.isArray(msg) ? msg : [msg];
        const out = (await Promise.all(batch.map(x => mcpHandle(hub, channel, as, x, req.signal)))).filter(Boolean);
        if (!out.length) return new Response(null, { status: 202 });
        const sid = !Array.isArray(msg) && msg.method === "initialize" ? { "mcp-session-id": crypto.randomUUID() } : {};
        return json(Array.isArray(msg) ? out : out[0], 200, sid);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      const err = e as HuddleError;
      return json({ error: err.message }, err.status ?? 500);
    }
}
// What a self-removal waits for: requests whose handler has not answered yet. A live stream has
// answered (its events run on after), so streams are closed, not awaited — and a blocking op that
// outwaits the drain is cut with its connection.
let inFlight = 0;
const wakers: (() => void)[] = [];
const tracked = (req: Request) => {
  inFlight++;
  return handle(req).finally(() => { if (--inFlight === 0) for (const w of wakers.splice(0)) w(); });
};
const drain = (ms: number) => new Promise<void>(resolve => {
  if (inFlight === 0) return resolve();
  const w = () => { clearTimeout(t); const i = wakers.indexOf(w); if (i >= 0) wakers.splice(i, 1); resolve(); };
  const t = setTimeout(w, ms);
  wakers.push(w);
});
// the native server on Bun, node:http on Node (src/rt.ts); no idle timeout: waits and live streams are long-lived by design
const server = await serve({ hostname: process.env.HOST ?? "127.0.0.1", port: PORT, fetch: tracked });
if (!PORT) { // PORT=0: the port the OS gave us names this server's hosts and cookie
  PORT = Number(server.port);
  HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...EXTRA_HOSTS]);
  COOKIE = `huddle_session_${PORT}`;
}

// a database that is not up yet fails /health (and each request) until it is; the server stays up
const names = await hub.names().catch(e => { console.error(`storage: ${e.message}`); return []; });
console.log(`Huddle ${VERSION} on http://${server.hostname}:${server.port} · data ${hub.where()} · channels ${names.join(", ") || "none"}`);
// a server started by hand on a terminal, with no root handed to it, shows how to get in once
if (!process.env.HUDDLE_TOKEN && process.env.HUDDLE_ROOT_STDIN !== "1" && process.stdout.isTTY)
  console.log(`root credential (this run only; HUDDLE_TOKEN=… for the CLI): ${ROOT_CRED}\ndashboard: http://127.0.0.1:${server.port}/?code=${AUTH.loginCode()}`);
const shutdown = () => { AUTH.flush(); hub.close().finally(() => process.exit(0)); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);

// Claude Code has no uninstall hook, and this server outlives the plugin that started it: when it
// was started by `huddle up` (HUDDLE_REMOVAL_WATCH), src/lifecycle.ts watches the plugin registry,
// and two agreeing checks that the plugin is uninstalled or disabled trigger this. The channels —
// the user's conversations — and every project's huddle.json are never touched.
const gone = async () => {
  console.log("huddle: the plugin is gone from Claude Code — stopping");
  server.stop();                                             // no new connections
  for (const s of [...streams]) s();                         // live streams end
  await drain(30_000);                                       // requests in flight finish, up to 30 s
  await sleep(100);                                      // their last bytes flush
  server.stop(true);                                         // what outwaited the drain goes with its connection
  for (const n of await hub.names())                         // every channel: fold its WAL into the file, then close it
    await hub.get(n, false).then(ch => ch.store.all("PRAGMA wal_checkpoint(TRUNCATE)"), () => {});
  await hub.close();
  removeRunFiles(HOME);                                      // the pid (our lock) and the log leave with us
  rmSync(AUTH_FILE, { force: true });                        // and who was in: nobody joins a server that is gone
  writeLeftBehind(HOME, hub.where());                        // the channels stay, with a note where they are
  process.exit(0);
};
const PROJECTS = [...new Set([process.env.CLAUDE_PROJECT_DIR, process.cwd()].filter(Boolean))] as string[];
const WATCH_MS = Number(process.env.HUDDLE_REMOVAL_MS || 10_000);
if (process.env.HUDDLE_REMOVAL_WATCH === "1")
  watchRemoval({ env: process.env, plugin: "huddle", projects: () => PROJECTS, ms: Number.isFinite(WATCH_MS) && WATCH_MS > 0 ? WATCH_MS : 10_000, gone });
