// tests/auth.test.ts — kubeadm-style invites and per-session credentials (src/auth.ts), on an
// injected clock.
import { test, expect } from "bun:test";
import { Auth, INVITE_RE, mayAct, rand36 } from "../plugin/server/src/auth";

const clock = () => { let t = 1_700_000_000_000; return { now: () => t, add: (s: number) => { t += s * 1000; } }; };

test("invites are <id>.<secret> in [a-z0-9]{6}.[a-z0-9]{16}, the whole token returned once and listed by id only", () => {
  const a = new Auth("root-cred-xyz");
  const inv = a.create({ by: "owner" });
  expect(inv.token).toMatch(INVITE_RE);
  expect(inv.token.startsWith(`${inv.id}.`)).toBe(true);
  expect(rand36(40)).toMatch(/^[a-z0-9]{40}$/);
  const listed = JSON.stringify(a.list());
  expect(listed).toContain(inv.id);
  expect(listed).not.toContain(inv.token.split(".")[1]);
  expect(a.list()[0]).toMatchObject({ id: inv.id, single_use: false, uses: 0 });
});

test("an invite expires after its TTL (24 h by default; 0 = never)", () => {
  const c = clock(), a = new Auth("root-cred-xyz", c.now);
  const day = a.create({ by: "owner" }), hour = a.create({ by: "owner", ttl: 3600 }), never = a.create({ by: "owner", ttl: 0 });
  c.add(3599); expect("credential" in a.join(hour.token, "early")).toBe(true);
  c.add(2);    expect(a.join(hour.token, "late")).toEqual({ error: "invalid token" });
  c.add(86_400); expect(a.join(day.token, "x")).toEqual({ error: "invalid token" });
  expect(a.list().map(i => i.id)).toEqual([never.id]); // the expired ones are gone from the list
  c.add(10 * 86_400); expect("credential" in a.join(never.token, "y")).toBe(true);
});

test("a single-use invite works once; a multi-use one until revoked", () => {
  const a = new Auth("root-cred-xyz");
  const once = a.create({ by: "owner", single: true }), many = a.create({ by: "owner" });
  expect("credential" in a.join(once.token, "a")).toBe(true);
  expect(a.join(once.token, "b")).toEqual({ error: "invalid token" });
  expect("credential" in a.join(many.token, "c")).toBe(true);
  expect("credential" in a.join(many.token, "d")).toBe(true);
  expect(a.list().find(i => i.id === many.id)?.uses).toBe(2);
  expect(a.revoke(many.id)).toBe(true);
  expect(a.join(many.token, "e")).toEqual({ error: "invalid token" });
  expect(a.revoke(many.id)).toBe(false);
});

test("a wrong secret, an unknown id or garbage is refused the same way", () => {
  const a = new Auth("root-cred-xyz");
  const inv = a.create({ by: "owner" });
  for (const bad of [`${inv.id}.0000000000000000`, "zzzzzz.0123456789abcdef", inv.id, "", "not a token", `${inv.token}x`])
    expect(a.join(bad, "x")).toEqual({ error: "invalid token" });
});

test("joining issues a credential bound to the name; a rejoin replaces it; kick revokes it", () => {
  const a = new Auth("root-cred-xyz");
  const inv = a.create({ by: "owner", channel: "shop" });
  const j = a.join(inv.token, "api") as any;
  expect(j).toMatchObject({ name: "api", channel: "shop" });
  expect(j.credential).not.toContain(inv.token.split(".")[1]);
  expect(a.who(j.credential)).toEqual({ name: "api", root: false, invite: false });
  expect(a.who("root-cred-xyz")).toEqual({ name: "owner", root: true, invite: true });
  expect(a.who("nope")).toBeNull();
  const again = a.join(inv.token, "api") as any;
  expect(a.who(j.credential)).toBeNull();           // the old one stops working
  expect(a.who(again.credential)?.name).toBe("api");
  expect(a.memberList().map(m => m.name)).toEqual(["api"]);
  expect(a.kick("api")).toBe(true);
  expect(a.who(again.credential)).toBeNull();
});

test("a member acts as itself and its subagents; root as anyone", () => {
  expect(mayAct({ name: "api", root: false, invite: false }, "api")).toBe(true);
  expect(mayAct({ name: "api", root: false, invite: false }, "api.explore")).toBe(true);
  expect(mayAct({ name: "api", root: false, invite: false }, "apix")).toBe(false);
  expect(mayAct({ name: "api", root: false, invite: false }, "owner")).toBe(false);
  expect(mayAct({ name: "owner", root: true, invite: true }, "anyone")).toBe(true);
});

test("a login code works once, within five minutes", () => {
  const c = clock(), a = new Auth("root-cred-xyz", c.now);
  const code = a.loginCode();
  const cookie = a.redeem(code)!;
  expect(a.who(cookie)).toMatchObject({ name: "owner", root: true });
  expect(a.redeem(code)).toBeNull();
  const late = a.loginCode(); c.add(301);
  expect(a.redeem(late)).toBeNull();
});

test("a member mints a login code for its own browser: the owner's dashboard, none of the creator's rights; gone with a kick", () => {
  const c = clock(), a = new Auth("root-cred-xyz", c.now);
  const j = a.join(a.create({ by: "owner" }).token, "api") as any;
  const cookie = a.redeem(a.loginCode("api"))!;
  const w = a.who(cookie)!;
  expect(w).toEqual({ name: "owner", root: false, invite: false, browser: "api" });
  expect(mayAct(w, "owner")).toBe(true);      // the dashboard acts as the owner in the channels
  expect(mayAct(w, "api")).toBe(false);       // not as a session
  expect(a.who(j.credential)?.name).toBe("api");
  const pending = a.loginCode("api");
  a.kick("api");
  expect(a.who(cookie)).toBeNull();           // its browser goes with it
  expect(a.redeem(pending)).toBeNull();       // and so do its unused codes
});

test("secrets never reach a channel: credentials, codes and this run's invites are redacted", () => {
  const a = new Auth("root-cred-xyz");
  const inv = a.create({ by: "owner" }), j = a.join(inv.token, "api") as any, code = a.loginCode();
  const body = { msg: `join with ${inv.token} please`, nested: [{ note: `cred ${j.credential} root root-cred-xyz code ${code}` }], keep: "abcdef.0123456789abcdef" };
  const out = a.redact(body);
  expect(out.msg).toBe(`join with ${inv.id}.<redacted> please`);
  expect(out.nested[0].note).toBe("cred <redacted> root <redacted> code <redacted>");
  expect(out.keep).toBe("abcdef.0123456789abcdef"); // not an invite of this run: left alone
});

test("with a state file, a restart remembers roots, members, browsers and unused invites as digests; kicks and expiry hold", () => {
  const { mkdtempSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
  const file = `${mkdtempSync(`${require("node:os").tmpdir()}/huddle-auth-`)}/data/auth.json`;
  const c = clock();
  const a = new Auth("root-one", c.now, () => {}, file);
  const keep = a.create({ by: "owner", channel: "shop" }), short = a.create({ by: "owner", ttl: 60 }), used = a.create({ by: "owner", single: true });
  const api = a.join(used.token, "api") as any, web = a.join(keep.token, "web") as any;
  const cookie = a.redeem(a.loginCode("api"))!, rootCookie = a.redeem(a.loginCode())!;
  const pending = a.loginCode();
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const disk = readFileSync(file, "utf8");
  for (const secret of ["root-one", api.credential, web.credential, cookie, rootCookie, pending, keep.token.split(".")[1], short.token.split(".")[1]])
    expect(disk).not.toContain(secret);
  // a new run, with a new root handed over: the old root still works, so does everyone else
  c.add(61);
  const b = new Auth("root-two", c.now, () => {}, file);
  expect(b.who("root-one")).toMatchObject({ root: true });
  expect(b.who("root-two")).toMatchObject({ root: true });
  expect(b.who(api.credential)).toMatchObject({ name: "api", root: false });
  expect(b.who(cookie)).toMatchObject({ browser: "api" });
  expect(b.who(rootCookie)).toMatchObject({ root: true });
  expect(b.redeem(pending)).toBeNull();                         // a login code is never kept
  expect("credential" in b.join(keep.token, "late")).toBe(true);  // an unused invite still works
  expect(b.join(short.token, "x")).toEqual({ error: "invalid token" }); // an expired one does not
  expect(b.join(used.token, "y")).toEqual({ error: "invalid token" });  // nor a used single-use one
  expect(b.redact(`invite ${keep.token}`)).toBe(`invite ${keep.id}.<redacted>`); // still known as ours
  expect(b.kick("api")).toBe(true);
  const d = new Auth("root-two", c.now, () => {}, file);
  expect(d.who(api.credential)).toBeNull();                     // a kick holds across a restart
  expect(d.who(cookie)).toBeNull();                             // and so does its browser's end
  expect(d.who(web.credential)?.name).toBe("web");
  expect(d.memberList().map(m => m.name).sort()).toEqual(["late", "web"]);
});

test("an unreadable state file is a fresh start, never a crash", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const file = `${mkdtempSync(`${require("node:os").tmpdir()}/huddle-auth-`)}/auth.json`;
  writeFileSync(file, "{torn");
  const a = new Auth("root-x", Date.now, () => {}, file);
  expect(a.who("root-x")).toMatchObject({ root: true });
  expect(a.memberList()).toEqual([]);
});
