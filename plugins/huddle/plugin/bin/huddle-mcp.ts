#!/usr/bin/env bun
// huddle-mcp — Huddle's MCP server over stdio, for a harness that spawns it. It forwards every
// JSON-RPC message to the Huddle service (POST /mcp/<channel>?as=<you>) and adds what HTTP
// cannot: pushes. While connected it follows GET /api/c/<channel>/live?as=<you> and sends each
// event meant for you (addressed to you, an ask, or a topic in HUDDLE_PUSH), and each message
// between other sessions (overheard: for your knowledge, not your answer), to the client as a
// claude/channel notification, so an idle Claude Code session wakes up without polling
// (research preview: claude --dangerously-load-development-channels server:plugin:huddle:huddle).
// Identity: env HUDDLE_URL/HUDDLE_CHANNEL/HUDDLE_AS, else the project's .agents/huddle/huddle.json. HUDDLE_PUSH (topic globs,
// comma separated; default "task.ready,turn.pass,ask,msg,control.*"; "off" disables),
// HUDDLE_WAIT (default wait timeout in s over stdio; default 1500, under the 30 min tool limit).
// Until this session is in a huddle it lists two tools only (status, and join with an invite), so a
// session with no Huddle carries a few hundred tokens of schema, not every operation's; once it is
// in (by this join, /huddle:join, setup or a session start), it sends notifications/tools/list_changed
// and lists them all. stdout is the protocol; diagnostics go to stderr.
import { identity, hfetch, slug } from "./identity";
import { tokenFor, saveCred } from "./creds";
import { dashboard } from "./serve";
import { sleep } from "../server/src/rt";
import { toolDefs } from "../server/src/ops";
import { instructions, VERSION } from "../server/src/mcp";
let { url: URL_, channel: CH, as: ME, push: PUSH, wait: WAIT } = identity();
// a session that joins after this bridge started (`huddle join <host:port> --token …`) is picked
// up on its next call: its channel and name come from the credential it now holds (a name the
// join made unique replaces the project's); and a server started after it (the first `huddle up`
// picks the project's port) is found the same way. Reading them is a few small files per call.
const refresh = () => { ({ url: URL_, channel: CH, as: ME } = identity()); };
const write = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const log = (...a: unknown[]) => console.error("huddle-mcp:", ...a);
const BLOCKING = ["wait", "wait_task", "gate", "depend", "handoff", "ask_wait"];
const CALL_MS = Number(process.env.HUDDLE_CALL_TIMEOUT_MS || 10_000); // a non-blocking call's deadline
const match = (t: string) => PUSH[0] !== "off" && PUSH.some(g => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(t));

// What needs no service is answered here, so the server connects in every state: before
// /huddle:setup, before this session joins, while the service is still starting. Claude Code
// would otherwise mark it failed at startup and keep the tools away for the whole session.
const NOT_IN = "not in a huddle yet: run /huddle:setup in this project (the first session), or paste the /huddle:join line that /huddle:invite shows in a session that is in one";
// in: a channel, a name, an address and a credential for it
const isIn = () => !!(CH && ME && URL_ && tokenFor(URL_));
let listedIn: boolean | null = null; // what the last tools/list showed
const OUT_TOOLS = [
  { name: "status", description: "Is this session in a Huddle? (Until it is, only this and join are listed.)", inputSchema: { type: "object", properties: {} } },
  { name: "join", description: "Join a Huddle with an invite: the host:port and token from the /huddle:join line the user pasted.", inputSchema: { type: "object", properties: {
    host_port: { type: "string", description: "e.g. 127.0.0.1:41873" }, token: { type: "string", description: "<id>.<secret> from the join line" }, as: { type: "string", description: "your name (default: the project folder's)" } }, required: ["host_port", "token"] } },
];
// a session that got in some other way (a session start, /huddle:join from Bash): the full tool list
setInterval(() => {
  if (listedIn !== false) return;
  refresh();
  if (isIn()) { listedIn = null; write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); }
}, 3000).unref?.();
// the two tools a session that is not in a huddle has
async function outside(m: any): Promise<boolean> {
  if (m.method !== "tools/call" || isIn()) return false;
  const text = (t: string, isError = false) => { if (m.id !== undefined) write({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) } }); return true; };
  const a = m.params?.arguments ?? {};
  if (m.params?.name !== "join") return text(`huddle: ${NOT_IN}`, m.params?.name !== "status");
  const host = String(a.host_port ?? "").trim(), url = (/^https?:\/\//.test(host) ? host : `http://${host}`).replace(/\/$/, "");
  if (!/^https?:\/\/[\w.-]+:\d+$/.test(url) || typeof a.token !== "string") return text("huddle: join needs host_port (host:port) and token", true);
  const wish = String(a.as || (ME ? ME.split(".")[0] : slug(process.env.CLAUDE_PROJECT_DIR || process.cwd())));
  try {
    const r = await fetch(`${url}/api/join`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(CALL_MS),
      body: JSON.stringify({ token: a.token, name: wish, unique: !a.as, channel: CH || undefined }) });
    const j = await r.json().catch(() => ({})) as any;
    if (!r.ok || !j.credential) return text(`huddle: ${j.error ?? `HTTP ${r.status}`}`, true);
    const channel = String(j.channel || CH || "");
    if (!channel) return text("huddle: joined, but the invite names no channel: ask for an invite made in a channel", true);
    saveCred({ url, channel, as: j.name, credential: j.credential });
  } catch { return text(`huddle: Huddle unreachable at ${url}`, true); }
  refresh();
  try { // in the channel, too, like `huddle join … --token` (the server keeps who is here)
    await hfetch(`${URL_}/api/c/${CH}/op/join?as=${encodeURIComponent(ME)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(CALL_MS) });
  } catch {}
  listedIn = null; write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  // the user's sign-in link, like `huddle join` prints: whichever way the session joined, the command
  // (/huddle:join) must be able to show it (commands/join.md shows the line it printed)
  const link = await dashboard(URL_).catch(() => null);
  return text(`joined ${url}, channel ${CH}, as ${ME}; this project's next sessions are in it too. Every Huddle tool is listed now: call status for the picture.${link ? `\ndashboard: ${link}   (signs your browser in once, within 5 min)` : " (huddle open, or /huddle:setup, prints the user a dashboard link that signs their browser in.)"}`);
}
function local(m: any): boolean {
  const ok = (result: unknown) => { if (m.id !== undefined) write({ jsonrpc: "2.0", id: m.id, result }); return true; };
  switch (m.method) {
    case "initialize":
      return ok({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {}, experimental: { "claude/channel": {} } },
        serverInfo: { name: "huddle", version: VERSION },
        instructions: CH && ME ? instructions(CH, ME) : `Huddle: this session is ${NOT_IN}. Its tools (mcp__plugin_huddle_huddle__*) are listed once it is in.` });
    case "ping": return ok({});
    case "tools/list": listedIn = isIn(); return ok({ tools: listedIn ? toolDefs() : OUT_TOOLS });
    case "resources/list": return ok({ resources: [] });
    case "prompts/list": return ok({ prompts: [] });
  }
  return false;
}

let initialized = false;
async function forward(m: any) {
  refresh();
  if (initialized && CH && ME && URL_) push();
  if (local(m)) return;
  if (await outside(m)) return;
  if (!CH || !ME) {
    if (m.id !== undefined) write({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `huddle: ${NOT_IN}` }], isError: true } });
    return;
  }
  if (!URL_) {
    if (m.id !== undefined) write({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "huddle: this project's Huddle has no port yet: start it with huddle up (it picks one and saves it). Treat yourself as paused and retry." }], isError: true } });
    return;
  }
  // blocking tools get the long stdio default unless the caller chose a timeout
  const blocking = m.method === "tools/call" && BLOCKING.includes(m.params?.name);
  if (blocking && m.params.arguments?.timeout === undefined)
    m.params.arguments = { ...(m.params.arguments ?? {}), timeout: m.params.name === "gate" ? 0 : WAIT };
  // every call has a client deadline: a blocking tool its own timeout (the server caps it at an
  // hour; gate's 0 means that hour) plus a margin, everything else 10 s — a stalled service never
  // holds a tool call open
  const ms = blocking ? (Math.min(3600, Number(m.params.arguments.timeout) || 3600) + 30) * 1000 : CALL_MS;
  try {
    const res = await hfetch(`${URL_}/mcp/${CH}?as=${encodeURIComponent(ME)}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(m),
      signal: AbortSignal.timeout(ms),
      // @ts-ignore Bun: the signal above is the deadline, not Bun's default client timeout
      timeout: false,
    });
    if (res.status === 202) return;
    if (res.status === 401 || res.status === 403) { // not (or no longer) in this huddle: a tool error, not a crash
      const e = await res.json().catch(() => ({})) as any;
      if (m.id !== undefined) write({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `huddle: ${e.error ?? `HTTP ${res.status}`}` }], isError: true } });
      return;
    }
    const j = await res.json();
    write(j);
  } catch (e) {
    const late = (e as Error)?.name === "TimeoutError";
    if (m.id !== undefined) write({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: late ? `huddle: no answer from ${URL_} within ${ms / 1000} s. Treat yourself as paused and retry.` : `huddle: service unreachable at ${URL_} (start it: huddle up). Treat yourself as paused and retry.` }], isError: true } });
  }
}

// the push stream: reconnects with backoff; resumes after the last pushed seq
let lastSeq = 0, pushing = false;
const pushed = new Set<number>(); // asks pushed from the inbox, ahead of the cursor
const deliver = (e: any, advance = true) => {
  if (pushed.has(e.seq) || (advance && e.seq <= lastSeq)) return;
  if (advance) lastSeq = e.seq; else pushed.add(e.seq);
  if (e.from === ME) return;
  const overheard = !!e.to && e.to !== ME;
  if (overheard ? !["msg", "ask", "reply"].includes(e.topic) : !(e.to === ME || e.needs_reply || match(e.topic))) return;
  write({ jsonrpc: "2.0", method: "notifications/claude/channel", params: {
    content: `${e.from} → ${e.to ?? "all"} · ${e.topic} #${e.seq}${e.ref ? ` (${e.ref})` : ""}: ${e.msg ?? ""}${overheard ? "\n(overheard: between other sessions, for your knowledge)" : e.needs_reply ? `\n(needs your reply: tool reply seq=${e.seq})` : ""}`,
    meta: { channel: CH, seq: String(e.seq), topic: e.topic.replace(/\./g, "_"), from: e.from.replace(/\./g, "_") } } });
};
const op = async (name: string, args: unknown) => {
  const r = await hfetch(`${URL_}/api/c/${CH}/op/${name}?as=${encodeURIComponent(ME)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(CALL_MS) });
  return ((await r.json()) as any).result as any[];
};
// what the stream cannot replay: on the first connect, the asks already waiting for you; after a
// reconnect, everything since the last pushed seq. Events that also arrive live are skipped by seq.
async function catchUp(last: number) {
  try {
    if (lastSeq) for (const e of await op("events", { after: lastSeq, limit: 500 })) deliver(e);
    else for (const e of await op("inbox", {})) deliver(e, false);
  } catch (e) { log("catch-up:", (e as Error).message); }
  lastSeq = Math.max(lastSeq, last);
}
async function push() {
  if (pushing || PUSH[0] === "off" || !CH || !ME || !URL_) return;
  pushing = true;
  for (let backoff = 1000; ; backoff = Math.min(backoff * 2, 30_000)) {
    try {
      const res = await hfetch(`${URL_}/api/c/${CH}/live?as=${encodeURIComponent(ME)}`, { headers: { accept: "text/event-stream" },
        // @ts-ignore
        timeout: false });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      backoff = 1000;
      let buf = "";
      for await (const chunk of res.body as any) {
        buf += new TextDecoder().decode(chunk);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split("\n").find(l => l.startsWith("data: "));
          if (!line) continue;
          const m = JSON.parse(line.slice(6));
          if (m.type === "hello") { await catchUp(m.data.last); continue; }
          if (m.type === "event") deliver(m.data);
        }
      }
      throw new Error("stream ended");
    } catch (e) { log("live stream:", (e as Error).message, `retry in ${backoff / 1000}s`); await sleep(backoff); }
  }
}

let buf = "";
for await (const chunk of process.stdin as any) {
  buf += new TextDecoder().decode(chunk);
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m: any; try { m = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); continue; }
    if (m.method === "notifications/initialized") { initialized = true; push(); }
    forward(m); // concurrent: a blocking wait must not hold up cancel or ping
  }
}
process.exit(0);
