#!/usr/bin/env bun
// huddle — the shell face of Huddle (same operations as the MCP tools; see `huddle help`).
// Background subagents have Bash but no MCP tools: this is how they join their parent's channel.
//
//   huddle join [--role "…"] [--fresh|--sync]  join (or resume); prints the picture (fresh: a brief, not the backlog)
//   huddle wait [glob…] [--timeout s]        block: 0 event · 3 message for you · 124 timeout
//   huddle ack <seq>                         handled everything up to seq
//   huddle listen [--after seq] [--state f] [--all]   stream the channel and its "listen" channels: one JSON
//                                            line per event from the others, also between other sessions
//                                            (--state: resume where the last listen stopped; --all: presence too)
//   huddle gate [--no-block]                 wait while paused (4 = paused, with --no-block)
//   huddle send [<to>] <msg…> [--ask]        message one session (or everyone)
//   huddle reply <seq> <msg…>                answer an ask
//   huddle pub <topic> <ref> <msg…> [--to s] publish an event
//   huddle next | task <id> | tasks [--owner s]
//   huddle doing|done|blocked|skipped <id> [note…]
//   huddle new <title…> [--owner s] [--after a,b]   create a task (for another session too)
//   huddle wait-task <id>                    block until a task is done
//   huddle start [id]                       gate check + take the task (or your next) + doing; prints it
//   huddle finish <evidence…> [--id x] [--result "…"]   done + share its output + what it released
//   huddle depend <session> <title…>        make a task for them, block yours on it, wait until released
//   huddle handoff <to> <msg…> [--title t]  (task for them +) pass the turn + wait
//   huddle ask <session> <question…>        ask and block until they answer (prints the answer)
//   huddle remember <kind> <title> <body…> [--tags a,b]   share knowledge
//   huddle recall [words…] | kb <id>          verified entries first; each shows its age and "may be stale"
//   huddle remember … [--scope server] [--force]   server: for every channel on this server; force: even if similar
//   huddle verify <id> [--undo] | share <id>  vouch for an entry · make it one for every channel on this server
//   huddle knowledge export [--verified]    the knowledge as Markdown, grouped by kind, to paste into CLAUDE.md
//   huddle pause|resume <session> [why…] | turn | pass <to> [msg…] | sessions | status | leave [summary…]
//   huddle map                              the big picture: phases, who does what, the critical path
//   huddle digest [--since 24h]             what happened since then, per session: finished, notes, knowledge,
//                                            blocked, open questions (and the estimated cost when Radar runs)
//   huddle assign <session> --fresh|--sync|--default [--task id]   orchestrator: how it rejoins (+ a task)
//   huddle brief <session> <text…>          orchestrator: what its next fresh join gets
//   huddle join <host:port> --token <id.secret> [--as name] [--channel c]   join a huddle with an invite: this
//                                            session gets its own credential (kept per session, never the invite)
//   huddle token create [--ttl 24h|0] [--single-use] [--can-invite] [--print-join-command] | token list | token delete <id>
//   huddle members | kick <name>            who holds a credential; revoke one (the creator only)
//   huddle open                             a dashboard link that signs your browser in once (5 min), for any session
//                                            that joined; inside Claude Code it reaches you through the next hook,
//                                            never Claude's context (/huddle:open)
//   huddle up [--port n] | down | server   run the server bundled with the plugin (files in .agents/huddle/; its
//                                            port is random per project, saved there, and shown by up and server)
//   huddle setup [show] [--port n] [--autostart|--no-autostart] [--listen a,b] [--no-notify] [--start] [--channel c --as s]   set up this machine and project
//   huddle <op> --key value …               any operation by name (huddle ops lists them)
// Identity: env HUDDLE_URL/HUDDLE_CHANNEL/HUDDLE_AS, else the nearest .agents/huddle/huddle.json up from the cwd
// (huddle whoami). A subagent runs with HUDDLE_AS=<parent>.<role>, or passes --as <parent>.<role>. Exit: 0 ok · 2 usage/error · 3 message · 4 paused · 5 Huddle unreachable · 124 timeout.
const argv = process.argv.slice(2);
const opt: Record<string, any> = {};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2).replace(/-/g, "_");
    if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opt[k] = argv[++i]; else opt[k] = true;
  } else pos.push(a);
}
import { identity, hfetch, slug } from "./identity";
import { loadCred, saveCred } from "./creds";
import { PLUGIN, sleep } from "../server/src/rt";
import { readFileSync } from "node:fs";
const ID = identity();
let URL_ = ID.url;
let CH = String(opt.channel ?? ID.channel);
let ME = String(opt.as_session ?? ID.as);
const RAW = { ...opt }; // setup reads --channel and --as as its own flags
const AS = opt.as ? String(opt.as) : undefined; delete opt.as; delete opt.channel;
const cmd = pos.shift() ?? "help";
const die = (m: string, code = 2): never => { console.error(`huddle: ${m}`); process.exit(code); };
// no url yet: this project's server has never started (huddle up picks its port)
const NO_PORT = "Huddle has no port here yet: start it with huddle up (it picks a random five-digit port and saves it)";

if (cmd === "help" || cmd === "-h") {
  const lines = readFileSync(`${PLUGIN}/bin/huddle.ts`, "utf8").split("\n").slice(1); // the comment block after the shebang (the source ships beside the bundle)
  console.log(lines.slice(1, lines.findIndex(l => !l.startsWith("//"))).map(l => l.slice(3)).join("\n"));
  process.exit(0);
}
if (cmd === "setup") process.exit(await (await import("./setup")).setup(pos.shift(), RAW, URL_));
if (cmd === "up" || cmd === "down" || cmd === "server") {
  const S = await import("./serve");
  if (cmd === "up" && opt.port !== undefined) { // a port of your choosing: it wins, and up saves it
    const p = Number(opt.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) die(`--port ${opt.port}: a port number`);
    process.env.HUDDLE_PORT = String(p); delete process.env.HUDDLE_URL; URL_ = `http://127.0.0.1:${p}`;
  }
  const r: { ok: boolean; msg: string; created?: boolean; url?: string } = await (cmd === "up" ? S.up : cmd === "down" ? S.down : S.info)(URL_);
  if (r.url) URL_ = r.url;
  (r.ok ? console.log : console.error)(r.msg);
  if (r.created) { // the creator: the join line for other sessions, and the dashboard
    const inv = await S.joinLine(URL_, { channel: CH || undefined, description: "made by huddle up" });
    if (inv.ok) console.log(inv.claude ? `join:  the line another Claude session pastes ${inv.line}` : `join:  huddle join ${inv.line.slice("/huddle:join ".length)}   (valid 24 h; in a Claude session: ${inv.line})`);
    const d = await S.dashboardFor(URL_);
    if (d) console.log(`UI:    ${d}`);
  }
  process.exit(r.ok ? 0 : cmd === "down" ? 2 : 5);
}
// the creator's side of joining: invites, members, the dashboard (server/src/auth.ts)
const admin = async (method: string, path: string, b?: unknown) => {
  if (!URL_) die(NO_PORT, 5);
  const r = await hfetch(`${URL_}${path}`, { method, headers: { "content-type": "application/json" }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) })
    .catch(() => die(`Huddle unreachable at ${URL_} (start it: huddle up)`, 5));
  const j = await r.json().catch(() => ({})) as any;
  if (!r.ok) die(j.error ?? `HTTP ${r.status}`);
  return j;
};
// 24h, 90m, 3600 (seconds), 0 = never expires
const seconds = (v: unknown) => {
  const m = /^(\d+)([smhd]?)$/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 } as any)[m[2]] : die(`--ttl ${v}: a number with s, m, h or d (0 = never expires)`);
};
if (cmd === "token") {
  const sub = pos.shift() ?? "list";
  if (sub === "create") {
    const S = await import("./serve");
    if (!URL_) die(NO_PORT, 5);
    const o = { ttl: opt.ttl === undefined ? undefined : seconds(opt.ttl), single_use: !!opt.single_use, can_invite: !!opt.can_invite,
      channel: CH || undefined, description: typeof opt.description === "string" ? opt.description : undefined };
    if (opt.print_join_command && S.inClaude()) { // /huddle:invite: the line goes to the user, not to Claude
      const l = await S.joinLine(URL_, o);
      if (!l.ok) die(l.error);
      console.log(`invite made for channel ${CH || "(the joiner's)"}: the /huddle:join line ${l.line}`);
      process.exit(0);
    }
    const inv = await S.invite(URL_, o);
    if (!inv.ok) die(inv.error);
    if (opt.print_join_command) console.log(`${inv.join}\n# in another Claude session: /huddle:join ${inv.join.slice("huddle join ".length)}`);
    else console.log(`${inv.token}  (id ${inv.id}, expires ${inv.expires ?? "never"})`);
  } else if (sub === "list") {
    const l = await admin("GET", "/api/tokens") as any[];
    console.log(l.length ? l.map(t => `${t.id}  expires ${t.expires ?? "never"}  ${t.single_use ? "single-use" : "multi-use"}  uses ${t.uses}${t.can_invite ? "  can-invite" : ""}${t.channel ? `  channel ${t.channel}` : ""}${t.description ? `  ${t.description}` : ""}`).join("\n") : "no tokens");
  } else if (sub === "delete") {
    const id = pos[0] ?? die("token delete <id>");
    await admin("DELETE", `/api/tokens/${encodeURIComponent(id.split(".")[0])}`); console.log(`token ${id.split(".")[0]} deleted`);
  } else die("token create|list|delete");
  process.exit(0);
}
if (cmd === "members") {
  const l = await admin("GET", "/api/members") as any[];
  console.log(l.length ? l.map(m => `${m.name}  since ${m.since}  last seen ${m.seen}  invite ${m.invite}${m.can_invite ? "  can-invite" : ""}`).join("\n") : "no members (the creator holds the root credential)");
  process.exit(0);
}
if (cmd === "kick") { const n = pos[0] ?? die("kick <name>"); await admin("DELETE", `/api/members/${encodeURIComponent(n)}`); console.log(`${n} kicked: its credential no longer works`); process.exit(0); }
if (cmd === "open") {
  if (!URL_) die(NO_PORT, 5);
  const d = await (await import("./serve")).dashboardFor(URL_);
  if (!d) die("this session is not in a huddle here: join with the command its owner gives you (/huddle:join <host:port> --token …)");
  console.log(`dashboard: ${d}`); process.exit(0);
}
// join a huddle with an invite: `huddle join <host:port> --token <id>.<secret>`; this session then
// holds its own credential (creds.ts) and joins the invite's channel (or --channel, or its own)
if (cmd === "join" && (opt.token || /^(https?:\/\/)?[\w.-]+:\d+\/?$/.test(pos[0] ?? ""))) {
  const host = pos.shift() ?? die("join <host:port> --token <id.secret>");
  const url = (/^https?:\/\//.test(host) ? host : `http://${host}`).replace(/\/$/, "");
  if (typeof opt.token !== "string") die("join <host:port> --token <id.secret>");
  const fallback = slug(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  // a name given (--as) is kept; this session joining again keeps the one it has; else the project's
  // (or folder's) name is only a wish, and the server makes it unique: another session of the same
  // project (the one that set it up, say) already goes by it
  const given = RAW.as ?? opt.name, prev = loadCred(url);
  const wish = String(given ?? (prev && !prev.root && prev.as) ?? (ID.as ? ID.as.split(".")[0] : fallback));
  const r = await fetch(`${url}/api/join`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: opt.token, name: wish, unique: !given && !(prev && !prev.root && prev.as), channel: ID.channel || undefined }) })
    .catch(() => die(`Huddle unreachable at ${url}`, 5));
  const j = await r.json().catch(() => ({})) as any;
  if (!r.ok) die(j.error ?? `HTTP ${r.status}`);
  const name = String(j.name ?? wish);
  // the invite's channel wins over this project's file: the owner invited you into that one
  const channel = String(RAW.channel ?? (j.channel || ID.channel || ""));
  if (!channel) die("joined, but the invite names no channel: run join again with --channel <c>");
  if (!RAW.channel && j.channel && ID.channel && ID.channel !== j.channel) console.error(`huddle: joined channel ${j.channel} (the invite's); this project's file named ${ID.channel}`);
  saveCred({ url, channel, as: name, credential: j.credential });
  console.error(`huddle: joined ${url} as ${name}; this project's next sessions are in it too (the invite is not kept)`);
  URL_ = url; CH = channel; ME = name; delete opt.token; delete opt.name;
  const d = await (await import("./serve")).dashboardFor(url);
  if (d) console.error(`huddle: dashboard ${d}`);
}
if (cmd === "whoami") { console.log(JSON.stringify(ID)); process.exit(0); }
if (!CH || !ME) die("not in a huddle: in a session that is in one, run /huddle:invite and paste its join line here (/huddle:join …); or run /huddle:setup to start one");
if (!URL_) die(NO_PORT, 5);

async function call(op: string, args: Record<string, any>): Promise<{ result: any; text: string | null }> {
  let res: Response;
  try {
    res = await hfetch(`${URL_}/api/c/${CH}/op/${op}?as=${encodeURIComponent(ME)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...args, ...(AS ? { as: AS } : {}) }),
      // @ts-ignore Bun: no client-side timeout; waits are bounded by their own timeout
      timeout: false,
    });
  } catch { return die(`Huddle unreachable at ${URL_} (start it: huddle up)`, 5); }
  const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as any;
  if (!res.ok || j.error) die(/^no operation /.test(String(j.error)) && op === cmd.replace(/-/g, "_") ? `no command or operation "${cmd}" (huddle help lists them)` : j.error ?? `HTTP ${res.status}`, res.status === 423 ? 4 : 2);
  return j;
}
const out = (r: { result: any; text: string | null }) => console.log(r.text ?? JSON.stringify(r.result, null, opt.pretty ? 1 : 0));
const list = (v: any) => v === undefined ? undefined : Array.isArray(v) ? v : String(v).split(",").map(s => s.trim()).filter(Boolean);
const rest = () => pos.join(" ");

switch (cmd) {
  case "listen": {
    // the channel and its "listen" channels (--channel: that one only), live and reconnecting;
    // after a gap (or from --after, with one channel) each first replays what it missed
    const chans = RAW.channel ? [CH] : [CH, ...ID.listen.filter(c => c !== CH)];
    // --state <file>: where each channel's last seq is kept, so a restarted listen resumes there
    const { readFileSync, writeFileSync } = await import("node:fs");
    const state: Record<string, number> = opt.state ? (() => { try { return JSON.parse(readFileSync(String(opt.state), "utf8")); } catch { return {}; } })() : {};
    const follow = async (ch: string) => {
      let last = state[ch] ?? (chans.length === 1 ? Number(opt.after ?? 0) : 0), connected = false;
      const print = (e: any) => {
        if (e.seq <= last) return; last = e.seq;
        if (opt.state) { state[ch] = last; writeFileSync(String(opt.state), JSON.stringify(state)); }
        if (e.from !== ME || opt.all) console.log(JSON.stringify({ channel: ch, ...e }));
      };
      if (!last && chans.length > 1 && opt.after == null) { // several channels: each starts from its newest event
        const r = await hfetch(`${URL_}/api/c/${ch}/timeline?limit=1`, { headers: {} }).catch(() => null);
        if (r?.ok) last = (await r.json() as any[]).at(-1)?.seq ?? 0;
      }
      const replay = async () => {
        if (!last) return;
        const r = await hfetch(`${URL_}/api/c/${ch}/timeline?after=${last}&limit=2000`, { headers: {} });
        if (r.ok) for (const e of await r.json() as any[]) print(e);
      };
      // a stream can go quiet without closing: the server pings every 15 s, so 45 s of nothing
      // means it is gone (reconnect); and every 30 s what the stream may have missed is read again
      // (print drops what was already shown)
      setInterval(() => { if (connected) replay().catch(() => {}); }, Number(process.env.HUDDLE_LISTEN_RESYNC_MS || 30_000));
      for (;;) {
        const ac = new AbortController();
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const alive = () => { clearTimeout(quiet); quiet = setTimeout(() => ac.abort(), Number(process.env.HUDDLE_LISTEN_QUIET_MS || 45_000)); };
        try {
          alive();
          const res = await hfetch(`${URL_}/api/c/${ch}/live${opt.all ? "" : `?as=${encodeURIComponent(ME)}`}`, { headers: { accept: "text/event-stream" }, signal: ac.signal,
            // @ts-ignore Bun: a stream has no client timeout
            timeout: false });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          connected = true;
          const dec = new TextDecoder();
          let buf = "";
          for await (const chunk of res.body as any) {
            alive();
            buf += dec.decode(chunk, { stream: true });
            let i: number;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              const data = block.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("\n");
              if (!data) continue;
              const m = JSON.parse(data);
              if (m.type === "hello") await replay();
              else if (m.type === "event") print(m.data);
              else if (opt.all) console.log(JSON.stringify(m));
            }
          }
        } catch { if (!connected) die(`Huddle unreachable at ${URL_} (start it: huddle up)`, 5); }
        finally { clearTimeout(quiet); }
        await sleep(2000);
      }
    };
    await Promise.all(chans.map(follow));
    break;
  }
  case "join": {
    const context = opt.fresh ? "fresh" : opt.sync ? "sync" : ["sync", "fresh"].includes(ID.context) ? ID.context : undefined;
    out(await call("join", { role: opt.role ?? ID.role, label: opt.label, task: opt.task ?? (rest() || undefined), context })); break;
  }
  case "map": out(await call("map", { json: opt.json })); break;
  case "assign": {
    const session = pos[0] ?? die("assign <session> --fresh|--sync|--default [--task id]");
    out(await call("assign", { session, context: opt.fresh ? "fresh" : opt.sync ? "sync" : null, task: opt.task })); break;
  }
  case "brief": { const session = pos.shift() ?? die("brief <session> <text>"); out(await call("brief", { session, msg: rest() || die("brief <session> <text>") })); break; }
  case "wait": {
    const timeout = Number(opt.timeout ?? 0);
    const topics = pos.length ? pos : list(opt.topics) ?? [];
    // forever = successive bounded waits, so no proxy or idle timer can cut one silently
    for (const end = timeout > 0 ? Date.now() + timeout * 1000 : Infinity; ;) {
      const left = end === Infinity ? 600 : Math.max(1, Math.ceil((end - Date.now()) / 1000));
      const r = await call("wait", { topics, timeout: Math.min(600, left) });
      if (r.result.kind === "timeout" && Date.now() < end) continue;
      console.log(JSON.stringify(r.result));
      process.exit(r.result.kind === "event" ? 0 : r.result.kind === "message" ? 3 : 124);
    }
  }
  case "wait-task": {
    const id = pos[0] ?? die("wait-task <id>");
    for (;;) { const r = await call("wait_task", { id, timeout: 600 }); if (r.result.kind !== "timeout") { console.log(JSON.stringify(r.result)); process.exit(0); } }
  }
  case "gate": {
    if (opt.no_block) { const r = await call("gate", { block: false }); console.log(JSON.stringify(r.result)); process.exit(r.result.control === "run" ? 0 : 4); }
    // fail closed: an unreachable Huddle counts as paused, so retry until it answers "run"
    for (;;) {
      const res = await hfetch(`${URL_}/api/c/${CH}/op/gate?as=${encodeURIComponent(ME)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeout: 600, ...(AS ? { as: AS } : {}) }),
        // @ts-ignore
        timeout: false }).then(r => r.json()).catch(() => null) as any;
      if (res?.result?.control === "run") { console.log(JSON.stringify(res.result)); process.exit(0); }
      if (res?.error) die(res.error);
      if (!res) { console.error("huddle: unreachable; treated as paused, retrying in 5 s"); await sleep(5000); }
    }
  }
  case "ack": out(await call("ack", { seq: Number(pos[0] ?? die("ack <seq>")) })); break;
  case "send": {
    const to = pos.length > 1 && /^[a-z][a-z0-9_.-]*$/.test(pos[0]) && opt.all === undefined ? pos.shift() : undefined;
    out(await call("send", { to: opt.to ?? to, msg: rest(), ask: !!opt.ask, task: opt.task })); break;
  }
  case "reply": { const seq = Number(pos.shift() ?? die("reply <seq> <msg>")); out(await call("reply", { seq, msg: rest() || "ack" })); break; }
  case "pub": { const [topic, ref, ...m] = pos; if (!topic || !ref || !m.length) die("pub <topic> <ref> <msg>"); out(await call("publish", { topic, ref, msg: m.join(" "), to: opt.to, ask: !!opt.ask, key: opt.key })); break; }
  case "doing": case "done": case "blocked": case "skipped": case "todo": {
    const id = pos.shift() ?? die(`${cmd} <task id> [note]`); out(await call("task_status", { id, status: cmd, note: rest() })); break;
  }
  case "new": out(await call("task_create", { title: rest(), owner: opt.owner, after: list(opt.after), id: opt.id, what: opt.what })); break;
  case "start": out(await call("start", { id: pos[0] })); break;
  case "finish": out(await call("finish", { id: opt.id, note: rest() || die("finish <evidence>"), result: opt.result, title: opt.title })); break;
  case "depend": {
    const owner = pos.shift() ?? die("depend <session> <title>");
    const r = await call("depend", { owner, title: rest() || die("depend <session> <title>"), what: opt.what, id: opt.id, timeout: 600 });
    console.log(JSON.stringify(r.result)); process.exit(r.result.woke?.kind === "event" ? 0 : r.result.woke ? 124 : 0);
  }
  case "handoff": {
    const to = pos.shift() ?? die("handoff <to> <msg>");
    const r = await call("handoff", { to, msg: rest() || die("handoff <to> <msg>"), title: opt.title, after: list(opt.after), wait: opt.no_wait ? false : undefined, timeout: 600 });
    console.log(JSON.stringify(r.result)); process.exit(!r.result.woke || r.result.woke.kind === "event" ? 0 : r.result.woke.kind === "message" ? 3 : 124);
  }
  case "ask": {
    const to = pos.shift() ?? die("ask <session> <question>");
    const r = await call("ask_wait", { to, msg: rest() || die("ask <session> <question>"), timeout: Number(opt.timeout ?? 600) });
    if (r.result.answer !== undefined) { console.log(r.result.answer); process.exit(0); }
    console.log(JSON.stringify(r.result)); process.exit(124);
  }
  case "remember": { const [kind, title, ...b] = pos; if (!kind || !title || !b.length) die("remember <kind> <title> <body>"); out(await call("remember", { kind, title, body: b.join(" "), tags: list(opt.tags), refs: list(opt.refs), task: opt.task, supersedes: opt.supersedes ? Number(opt.supersedes) : undefined, scope: opt.scope, force: !!opt.force })); break; }
  case "verify": out(await call("verify", { id: Number(pos[0] ?? die("verify <id> [--undo]")), undo: !!opt.undo })); break;
  case "share": out(await call("share", { id: Number(pos[0] ?? die("share <id>")) })); break;
  case "knowledge": {
    if (pos[0] !== "export") die("knowledge export [--verified]");
    const r = await hfetch(`${URL_}/api/c/${CH}/knowledge.md${opt.verified ? "?verified=1" : ""}`, { headers: {} }).catch(() => die(`Huddle unreachable at ${URL_} (start it: huddle up)`, 5));
    if (!r.ok) die((await r.json().catch(() => ({})) as any).error ?? `HTTP ${r.status}`);
    process.stdout.write(await r.text()); break;
  }
  case "recall": out(await call("recall", { q: rest(), kind: opt.kind, tag: opt.tag, limit: opt.limit ? Number(opt.limit) : undefined })); break;
  case "kb": out(await call("kb", { id: Number(pos[0] ?? die("kb <id>")) })); break;
  case "task": out(await call("task", { id: pos[0] ?? die("task <id>"), json: opt.json })); break;
  case "pause": case "resume": { const target = pos.shift() ?? die(`${cmd} <session>`); out(await call(cmd, { target, why: rest() })); break; }
  case "pass": { const to = pos.shift() ?? die("pass <to> [msg]"); out(await call("pass", { to, msg: rest() })); break; }
  case "leave": out(await call("leave", { summary: rest() })); break;
  case "ops": {
    const res = await hfetch(`${URL_}/mcp/${CH}?as=${encodeURIComponent(ME)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }).then(r => r.json()).catch(() => die("unreachable", 5)) as any;
    for (const t of res.result.tools) console.log(`${t.name.padEnd(12)} ${t.description}`);
    break;
  }
  default: {
    // any operation by name: --key value pairs (comma lists for array fields, numbers parsed)
    const args: Record<string, any> = {};
    for (const [k, v] of Object.entries(opt)) args[k] = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v === "true" ? true : v === "false" ? false : v;
    for (const k of ["topics", "after", "tags", "refs", "members"]) if (typeof args[k] === "string") args[k] = list(args[k]);
    if (pos.length && args.msg === undefined) args.msg = rest();
    out(await call(cmd.replace(/-/g, "_"), args));
  }
}
process.exit(0);
