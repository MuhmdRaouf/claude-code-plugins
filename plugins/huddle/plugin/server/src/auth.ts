// src/auth.ts — who may talk to this server, kubeadm style. A server started with a state file
// (<home>/auth.json, 0600) remembers its members, roots, browsers and unused invites across
// restarts and reboots, as sha256 digests only: no secret ever reaches the disk. A kick
// revokes at once, an invite expires on its TTL, and a login code (5 min) is never kept.
//   root       the credential of the session that started the server (handed to it on stdin by
//              `huddle up`, or HUDDLE_TOKEN): acts as anyone, the owner included; mints invites.
//              The digests of the last few roots are kept, so the creator's credential still works
//              after a restart (`huddle up` hands the same one over when this project holds it)
//   invites    "<id>.<secret>" ([a-z0-9]{6}.[a-z0-9]{16}), TTL (24 h by default, 0 = none),
//              optionally single-use, listable by id and revocable
//   members    a session that presents an invite once gets its own credential, bound to its name:
//              it acts as that name or its subagents (<name>.<role>); `kick` revokes it
//   browsers   a one-time login code (5 min), which any session holding a credential (root or a
//              member) mints for itself, is redeemed for a cookie that acts as the owner in the
//              channels — the dashboard. A browser the root signed in has the root's rights; one a
//              member signed in has no admin rights (no invites, members, kicks or login codes) and
//              stops working when that member is kicked
// Clients send a credential in header x-huddle-token; a browser sends its cookie. Secrets are
// compared in constant time; only an invite's id (its public half) is ever listed or logged.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const HEADER = "x-huddle-token";
export const INVITE_RE = /^([a-z0-9]{6})\.([a-z0-9]{16})$/;
export const DAY = 86_400;
const CODE_MS = 5 * 60_000;

// browser: the member whose login code signed this browser in (absent for sessions and for the root's browsers)
export type Who = { name: string; root: boolean; invite: boolean; browser?: string };
type Invite = { id: string; secret: Buffer; created: number; expires: number | null; single: boolean; uses: number; invite: boolean; channel?: string; description?: string; by: string };
type Member = { name: string; cred: Buffer; since: number; seen: number; invite: boolean; via: string };

const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";
// n characters of [a-z0-9], uniform (bytes past the last multiple of 36 are drawn again)
export function rand36(n: number): string {
  let out = "";
  while (out.length < n) for (const b of randomBytes(n * 2)) { if (b < 252 && out.length < n) out += ALPHA[b % 36]; }
  return out;
}
export const credential = () => `hcred_${randomBytes(32).toString("base64url")}`;
const digest = (s: string) => createHash("sha256").update(s).digest();
const same = (a: Buffer, b: Buffer) => timingSafeEqual(a, b); // both sha256: equal lengths, nothing leaks
const hex = (b: Buffer) => b.toString("hex");
const unhex = (s: unknown) => { const b = Buffer.from(String(s ?? ""), "hex"); return b.length === 32 ? b : null; };
const ROOTS = 8, BROWSERS = 64; // digests kept: the last few roots, the latest browsers

export class Auth {
  private roots: Buffer[] = [];
  private invites = new Map<string, Invite>();
  private issued = new Set<string>();         // every invite id of this run, for redaction
  private members = new Map<string, Member>();
  private browsers: { cred: Buffer; by: string | null }[] = [];  // by: the member who signed it in, null = the root
  private codes: { code: Buffer; expires: number; by: string | null }[] = [];
  private live = new Set<string>();            // every secret handed out: never stored in a channel
  private dirty = false;
  private flushT: ReturnType<typeof setTimeout> | undefined;
  // file: where the digests persist (none: memory only, a restart forgets it all)
  constructor(private root: string, private now: () => number = Date.now, private log: (s: string) => void = () => {}, private file?: string) {
    this.load();
    const d = digest(root);
    this.roots = [...this.roots.filter(r => !same(r, d)), d].slice(-ROOTS);
    this.live.add(root);
    this.save();
  }

  // the state file: digests and public metadata only; anything unreadable is a fresh start
  private load() {
    if (!this.file) return;
    let j: any;
    try { j = JSON.parse(readFileSync(this.file, "utf8")); } catch { return; }
    if (!j || j.v !== 1) return;
    this.roots = (Array.isArray(j.roots) ? j.roots : []).map(unhex).filter(Boolean) as Buffer[];
    for (const i of Array.isArray(j.invites) ? j.invites : []) {
      const secret = unhex(i?.secret);
      if (!secret || typeof i.id !== "string") continue;
      this.invites.set(i.id, { id: i.id, secret, created: Number(i.created) || 0, expires: i.expires == null ? null : Number(i.expires), single: !!i.single, uses: Number(i.uses) || 0,
        invite: !!i.invite, channel: i.channel || undefined, description: i.description || undefined, by: String(i.by ?? "owner") });
    }
    for (const id of Array.isArray(j.issued) ? j.issued : []) if (typeof id === "string") this.issued.add(id);
    for (const m of Array.isArray(j.members) ? j.members : []) {
      const cred = unhex(m?.cred);
      if (!cred || typeof m.name !== "string") continue;
      this.members.set(m.name, { name: m.name, cred, since: Number(m.since) || 0, seen: Number(m.seen) || 0, invite: !!m.invite, via: String(m.via ?? "") });
    }
    for (const b of Array.isArray(j.browsers) ? j.browsers : []) { const cred = unhex(b?.cred); if (cred) this.browsers.push({ cred, by: typeof b.by === "string" ? b.by : null }); }
    this.sweep();
  }
  private save() {
    if (!this.file) return;
    clearTimeout(this.flushT); this.flushT = undefined; this.dirty = false;
    const j = { v: 1, note: "Huddle's members, roots, browsers and unused invites: sha256 digests only, never a secret",
      roots: this.roots.map(hex),
      invites: [...this.invites.values()].map(i => ({ ...i, secret: hex(i.secret) })),
      issued: [...this.issued].slice(-1000),
      members: [...this.members.values()].map(m => ({ ...m, cred: hex(m.cred) })),
      browsers: this.browsers.slice(-BROWSERS).map(b => ({ cred: hex(b.cred), by: b.by })) };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(j), { mode: 0o600 });
      renameSync(tmp, this.file);
      try { chmodSync(this.file, 0o600); } catch {}
    } catch (e) { this.log(`could not save ${this.file}: ${(e as Error).message}`); }
  }
  // "last seen" changes on every request: written within a minute, not on each one
  private later() {
    if (!this.file || this.flushT) return;
    this.dirty = true;
    this.flushT = setTimeout(() => this.flush(), 60_000);
    (this.flushT as any).unref?.();
  }
  /** Write what is pending now (the server calls it when it stops). */
  flush() { if (this.dirty || this.flushT) this.save(); }

  // who a credential is: root (and the browsers, as the owner), a member, or nobody
  who(cred: string): Who | null {
    if (!cred) return null;
    const d = digest(cred);
    let found: Who | null = null;
    for (const r of this.roots) if (same(d, r)) found = { name: "owner", root: true, invite: true };
    for (const b of this.browsers) if (same(d, b.cred))
      found = b.by === null ? { name: "owner", root: true, invite: true } : this.members.has(b.by) ? { name: "owner", root: false, invite: false, browser: b.by } : found;
    for (const m of this.members.values()) if (same(d, m.cred)) { found = { name: m.name, root: false, invite: m.invite }; m.seen = this.now(); this.later(); }
    return found;
  }

  // a new invite; the whole token is returned once, here
  create(o: { ttl?: number; single?: boolean; invite?: boolean; channel?: string; description?: string; by: string }) {
    let id: string; do id = rand36(6); while (this.issued.has(id));
    const secret = rand36(16), ttl = o.ttl ?? DAY, created = this.now();
    const inv: Invite = { id, secret: digest(secret), created, expires: ttl > 0 ? created + ttl * 1000 : null, single: !!o.single, uses: 0, invite: !!o.invite,
      channel: o.channel || undefined, description: o.description || undefined, by: o.by };
    this.invites.set(id, inv); this.issued.add(id);
    const token = `${id}.${secret}`; this.live.add(token);
    this.log(`invite ${id} created by ${o.by}${inv.expires ? `, expires ${new Date(inv.expires).toISOString()}` : ""}${inv.single ? ", single use" : ""}`);
    this.save();
    return { token, ...this.view(inv) };
  }
  private view(i: Invite) {
    return { id: i.id, created: new Date(i.created).toISOString(), expires: i.expires ? new Date(i.expires).toISOString() : null, single_use: i.single,
      uses: i.uses, can_invite: i.invite, channel: i.channel ?? null, description: i.description ?? null, by: i.by };
  }
  list() { this.sweep(); return [...this.invites.values()].map(i => this.view(i)); }
  revoke(id: string): boolean { const ok = this.invites.delete(id); if (ok) { this.log(`invite ${id} revoked`); this.save(); } return ok; }
  private sweep() {
    const t = this.now(); let gone = false;
    for (const [id, i] of this.invites) if (i.expires !== null && i.expires <= t) { this.invites.delete(id); gone = true; }
    if (gone) this.save();
  }

  // the live invite a token names, or null (the secret is compared even when the id is unknown,
  // so a miss costs the same)
  private valid(token: string): Invite | null {
    const m = INVITE_RE.exec(String(token ?? ""));
    const inv = m ? this.invites.get(m[1]) : undefined;
    const ok = same(digest(m?.[2] ?? String(token ?? "")), inv?.secret ?? digest("\0no invite"));
    if (!inv || !ok) return null;
    if (inv.expires !== null && inv.expires <= this.now()) { this.invites.delete(inv.id); this.save(); return null; }
    return inv;
  }
  // before a join that asks for a name of its own: the channel the invite names (null: none) and
  // the member names taken, or null for a token that would not join
  peek(token: string): { channel: string | null; members: string[] } | null {
    const inv = this.valid(token);
    return inv ? { channel: inv.channel ?? null, members: [...this.members.keys()] } : null;
  }
  // present an invite once: a credential of its own for that name (a name joining again gets a
  // new one, and the old one stops working)
  join(token: string, name: string): { credential: string; name: string; channel: string | null } | { error: string } {
    const inv = this.valid(token);
    if (!inv) return { error: "invalid token" };
    const cred = credential();
    this.members.set(name, { name, cred: digest(cred), since: this.now(), seen: this.now(), invite: inv.invite, via: inv.id });
    this.live.add(cred);
    inv.uses++;
    if (inv.single) this.invites.delete(inv.id);
    this.log(`${name} joined with invite ${inv.id}`);
    this.save();
    return { credential: cred, name, channel: inv.channel ?? null };
  }
  memberList() { return [...this.members.values()].map(m => ({ name: m.name, since: new Date(m.since).toISOString(), seen: new Date(m.seen).toISOString(), can_invite: m.invite, invite: m.via })); }
  kick(name: string): boolean {
    const ok = this.members.delete(name);
    if (ok) { this.browsers = this.browsers.filter(b => b.by !== name); this.codes = this.codes.filter(c => c.by !== name); this.log(`${name} kicked`); this.save(); }
    return ok;
  }

  // the browser's door: a code good once, for five minutes, redeemed for a cookie credential;
  // by = the member who asks for it (its browser gets no admin rights), null = the root
  loginCode(by: string | null = null): string {
    const code = randomBytes(18).toString("base64url"), t = this.now();
    this.codes = this.codes.filter(c => c.expires > t);
    this.codes.push({ code: digest(code), expires: t + CODE_MS, by });
    this.live.add(code);
    return code;
  }
  redeem(code: string): string | null {
    const d = digest(code ?? ""), t = this.now();
    const i = this.codes.findIndex(c => same(c.code, d));
    if (i < 0) return null;
    const [c] = this.codes.splice(i, 1);
    if (c.expires <= t || (c.by !== null && !this.members.has(c.by))) return null;
    const cred = credential();
    this.browsers.push({ cred: digest(cred), by: c.by }); this.live.add(cred);
    if (this.browsers.length > BROWSERS) this.browsers.splice(0, this.browsers.length - BROWSERS);
    this.save();
    return cred;
  }

  // what a session writes into a channel never carries a secret: any credential, code or invite
  // of this run becomes "<redacted>" (an invite keeps its public id)
  redact<T>(v: T): T {
    const scrub = (s: string) => {
      let out = s.replace(/\b([a-z0-9]{6})\.([a-z0-9]{16})\b/g, (all, id) => this.issued.has(id) ? `${id}.<redacted>` : all)
        .replace(/hcred_[A-Za-z0-9_-]+/g, "<redacted>");
      for (const x of this.live) if (x.length >= 8 && out.includes(x)) out = out.split(x).join("<redacted>");
      return out;
    };
    const walk = (x: any): any => typeof x === "string" ? scrub(x) : Array.isArray(x) ? x.map(walk)
      : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
    return walk(v);
  }
}

// may a caller act as `as`? root: anyone; a member: itself and its subagents (<name>.<role>)
export const mayAct = (w: Who, as: string) => w.root || !as || as === w.name || as.startsWith(`${w.name}.`);

// what a request carries: the header, else this server's cookie
export function given(req: Request, cookie: string): string {
  const h = req.headers.get(HEADER);
  if (h) return h;
  const m = new RegExp(`(?:^|;\\s*)${cookie}=([^;]*)`).exec(req.headers.get("cookie") ?? "");
  return m ? decodeURIComponent(m[1]) : "";
}
