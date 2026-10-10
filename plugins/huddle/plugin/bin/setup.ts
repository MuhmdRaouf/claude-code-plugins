// setup.ts — `huddle setup`: this project's .agents/huddle/huddle.json, kept out of git.
//   huddle setup show                                   what is set up now
//   huddle setup [--channel <name> --as <session> [--role "…"]] [--autostart|--no-autostart]
//                [--port <n>] [--listen a,b | --no-listen] [--notify|--no-notify] [--start]
// A first setup asks nothing: without --channel/--as both are the project folder's name, and
// autostart is on. --autostart: the SessionStart hook runs `huddle up` when nothing answers. --port: the server's
// port, of your choosing, saved in the home's huddle.json (without it, the first `huddle up` picks
// a random five-digit one and saves that). --listen: more channels whose messages the hooks bring
// into this project's sessions. --start: start the server now (one huddle up started on another
// port is restarted on the new one). A .agents/.huddle.json is folded into huddle.json and
// removed. The UI is the server's own address, http://127.0.0.1:<port>. --no-notify: no desktop
// notifications when something needs you (a question, a paused session, an approval request, a
// blocked task); they are on by default (--notify turns them back on; the dashboard's Settings too).
// One Huddle per user is the usual shape: a first setup in a project with no settings looks for a
// Huddle this user already runs (serve.ts registry) and joins it instead of starting a second one
// (through the credential its project holds: a single-use invite, made and redeemed at once);
// --new starts a separate one anyway. --restart stops this project's server first (members stay in).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FILE, LEGACY, findConfig, mainCheckout, identity, savedPort, savePort, slug } from "./identity";
import { home, dataDir, keepOutOfGit, pidOf, up, down, info, joinLine, dashboard, servers, healthy } from "./serve";
import { loadCred, projectCred, saveCred } from "./creds";
import { HEADER } from "../server/src/auth";
import { Notifier } from "../server/src/notify";
import { hfetch } from "./creds";

type Opts = Record<string, any>;
const say = (s: string) => console.log(s);
class SetupError extends Error {}
const fail = (m: string): never => { throw new SetupError(m); };
const read = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } };

export async function setup(sub: string | undefined, o: Opts, url: string): Promise<number> {
  try {
    const found = findConfig();
    if (sub === "show") {
      say(`settings: ${found ? `${found.file} ${JSON.stringify(found.cfg)}` : "none yet (run huddle setup)"}`);
      say(`files:    ${home()}`);
      const sp = savedPort(home());
      say(`port:     ${sp ? `${sp.port}${sp.auto ? " (picked at random by huddle up)" : ""}` : "none yet (huddle up picks a random five-digit one)"}`);
      say(`notify:   desktop notifications ${new Notifier(dataDir()).enabled() ? "on" : "off"} (huddle setup --no-notify | --notify)`);
      say((await info(url)).msg);
      return 0;
    }
    if (sub) fail(`unknown setup ${sub}: use show, or flags only`);
    if (o.no_notify || o.notify === true) say(await notify(!o.no_notify, url));
    if (!found && !o.new && !o.port) { const n = await joinRunning(o); if (n !== null) return n; }
    if ((o.channel && !o.as) || (o.as && !o.channel)) fail("--channel and --as go together");
    const port = o.port === undefined ? undefined : Number(o.port);
    if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) fail(`--port ${o.port}: a port number`);
    // the project: where settings already are, else the main checkout of this repo, else the cwd
    const root = found?.root ?? mainCheckout() ?? (process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const file = join(root, FILE), legacy = join(root, LEGACY);
    const next: Record<string, any> = { ...read(legacy), ...read(file) };
    if (o.channel) Object.assign(next, { channel: String(o.channel), as: String(o.as) });
    // nothing to ask a first setup: the channel and this session are named after the project, and
    // the SessionStart hook starts the server when it is down (--channel/--as, --no-autostart change it)
    else if (!next.channel || !next.as) { const n = slug(root, "huddle"); next.channel ||= n; next.as ||= n; }
    if (o.role) next.role = String(o.role);
    if (o.autostart === true || (next.autostart === undefined && !o.no_autostart)) next.autostart = true;
    if (o.no_autostart) next.autostart = false;
    if (typeof o.listen === "string") next.listen = o.listen.split(",").map((x: string) => x.trim()).filter(Boolean);
    if (o.no_listen) delete next.listen;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    say(`${file}: ${JSON.stringify(next)}`);
    if (existsSync(legacy)) { rmSync(legacy); say(`folded ${legacy} into it`); }
    const ex = keepOutOfGit(join(root, ".agents", "huddle"));
    if (ex) say(`kept .agents/huddle/ out of git (${ex})`);
    say(`channels: ${dataDir()}/channels`);
    if (port !== undefined) {
      const was = url;
      say(`port:     ${port} (saved in ${savePort(port, false, home())})`);
      const me = identity(); // HUDDLE_URL, huddle.json's url and HUDDLE_PORT still win over it
      url = ["env", "config", "port"].includes(me.source) ? me.url : `http://127.0.0.1:${port}`;
      if (url !== `http://127.0.0.1:${port}`) say(`note:     ${me.source === "port" ? "HUDDLE_PORT" : me.source === "env" ? "HUDDLE_URL" : "huddle.json's url"} wins: the server stays at ${url}`);
      if (o.start && pidOf() !== null && was && was !== url) say((await down(was)).msg);
    }
    if (o.restart && pidOf() !== null) { say((await down(url)).msg); o.start = true; }
    if (o.start) {
      const r = await up(url); say(r.msg); if (!r.ok) return 5;
      url = r.url;
      await enter(url, next.channel, next.as); // this session is in now, so the channel exists: huddle status answers
      // the line another Claude session pastes in, and the dashboard link, printed for the user
      // (the server is localhost-only; nothing here is kept from Claude), started or not
      const inv = await joinLine(url, { channel: next.channel, description: "made by huddle setup" });
      if (inv.ok) say(`join:     ${inv.line}   (valid ${inv.expires ? `until ${inv.expires}` : "forever"})`);
      const d = await dashboard(url); if (d) say(`dashboard: ${d}`);
    }
    else if (!(await info(url)).ok) say("start it with: huddle up");
    return 0;
  } catch (e) {
    if (e instanceof SetupError) { console.error(`huddle setup: ${e.message}`); return 2; }
    throw e;
  }
}

// this session joins its channel now, so the channel exists before the next session start (the
// hooks join then): `huddle status` answers right after setup, also from a plain terminal
async function enter(url: string, channel: string, as: string): Promise<void> {
  const me = identity();
  await hfetch(`${url}/api/c/${me.channel || channel}/op/join?as=${encodeURIComponent(me.as || as)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(me.role ? { role: me.role } : {}), task: "set up" }), signal: AbortSignal.timeout(5000) }).catch(() => {});
}

// another Huddle of this user, alive: join it (null: none, go on and start this project's own)
async function joinRunning(o: Opts): Promise<number | null> {
  const mine = home();
  const live: { home: string; url: string; channel?: string; project?: string }[] = [];
  for (const [h, e] of Object.entries(servers())) if (h !== mine && e?.url && await healthy(e.url, 800)) live.push({ home: h, ...e });
  if (!live.length) return null;
  const e = live[0], where = e.project ?? e.home;
  const held = loadCred(e.url);
  if (held) { say(`This project is already in the Huddle at ${e.url} (channel ${held.channel ?? e.channel}, as ${held.as}). To start a separate one: /huddle:setup --new`); return 0; }
  const c = e.project ? projectCred(e.project, e.url) : null;
  if (!c) {
    say(`A Huddle already runs for ${where} at ${e.url} (channel ${e.channel ?? "?"}). To join it, run /huddle:invite in a session there and paste its join line here (/huddle:join …). To start a separate one anyway: /huddle:setup --new`);
    return 0;
  }
  // a single-use invite from that project's credential, redeemed at once: an invite and a join in one step
  const made = await fetch(`${e.url}/api/tokens`, { method: "POST", headers: { "content-type": "application/json", [HEADER]: c.credential },
    body: JSON.stringify({ ttl: 120, single_use: true, channel: e.channel, description: "huddle setup in another project" }), signal: AbortSignal.timeout(5000) }).catch(() => null);
  const tk = made?.ok ? await made.json().catch(() => ({})) as any : {};
  if (!tk.token) { say(`A Huddle already runs for ${where} at ${e.url}, but this machine holds no credential there that may invite. Run /huddle:invite in a session there and paste its join line here, or /huddle:setup --new for a separate one.`); return 0; }
  const root = mainCheckout() ?? (process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const wish = o.as ? String(o.as) : slug(root);
  const r = await fetch(`${e.url}/api/join`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: tk.token, name: wish, unique: !o.as, channel: e.channel }) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) as any : {};
  if (!r?.ok || !j.credential) { say(`A Huddle already runs for ${where} at ${e.url}, but joining it failed (${j.error ?? "unreachable"}). /huddle:setup --new starts a separate one.`); return 5; }
  const channel = String(o.channel ?? j.channel ?? e.channel ?? "");
  saveCred({ url: e.url, channel, as: j.name, credential: j.credential });
  await fetch(`${e.url}/api/c/${channel}/op/join?as=${encodeURIComponent(j.name)}`, { method: "POST", headers: { "content-type": "application/json", [HEADER]: j.credential },
    body: JSON.stringify({ role: o.role, task: "set up" }), signal: AbortSignal.timeout(5000) }).catch(() => {});
  say(`Joined the Huddle that already runs for ${where}: ${e.url}, channel ${channel}, as ${j.name}. This project's sessions are in it from now on (no second Huddle started; /huddle:setup --new starts a separate one).`);
  const d = await dashboard(e.url); if (d) say(`dashboard: ${d}`);
  return 0;
}

// desktop notifications on or off: in this home's data dir (read by the server it runs), and on the
// running server this session is in, if any (another project's Huddle keeps its own switch)
async function notify(on: boolean, url: string): Promise<string> {
  new Notifier(dataDir()).set(on);
  let there = "";
  if (url) {
    const r = await hfetch(`${url}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notify: on }), signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (r?.ok) there = ` (also on the running Huddle at ${url})`;
  }
  return `notify:   desktop notifications ${on ? "on" : "off"}${there}`;
}
