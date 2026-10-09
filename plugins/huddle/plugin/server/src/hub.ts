// src/hub.ts — every channel, each its own SQLite file DATA/channels/<name>.db, opened on first
// use and kept open.
import { readdirSync, existsSync, mkdirSync } from "node:fs";
import { Channel, HuddleError } from "./channel";
import { Store } from "./store";
import { Shared, attachShared } from "./knowledge";

export const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class Hub {
  // autoCreate: a session's join creates the channel it names
  private open = new Map<string, Promise<Channel>>();
  // knowledge for every channel on this server (src/knowledge.ts), opened with the first channel
  private shared: Promise<Shared> | null = null;

  constructor(readonly dir: string, readonly autoCreate = true) {
    mkdirSync(`${dir}/channels`, { recursive: true });
  }
  // where the channels live, for logs
  where() { return this.dir; }
  file(name: string) { return `${this.dir}/channels/${name}.db`; }
  async exists(name: string) {
    return this.open.has(name) || existsSync(this.file(name));
  }
  async names(): Promise<string[]> {
    try { return readdirSync(`${this.dir}/channels`).filter(f => f.endsWith(".db")).map(f => f.slice(0, -3)).filter(n => CHANNEL_RE.test(n)).sort(); }
    catch { return []; }
  }
  async get(name: string, create = this.autoCreate): Promise<Channel> {
    if (!CHANNEL_RE.test(name)) throw new HuddleError(400, `channel name must match ${CHANNEL_RE}`);
    let c = this.open.get(name);
    if (c) return c;
    if (!create && !(await this.exists(name))) throw new HuddleError(404, `no channel ${name}`);
    c = this.open.get(name); // another request may have opened it meanwhile
    if (c) return c;
    c = (async () => {
      const store = await Store.sqlite(this.file(name));
      const ch = await Channel.open(name, store);
      this.shared ??= Shared.open(`${this.dir}/shared.db`);
      const shared = await this.shared.catch(e => { console.error(`shared knowledge: ${e.message}`); return null; }); // a channel works without it
      if (shared) attachShared(ch, shared);
      return ch;
    })();
    this.open.set(name, c);
    c.catch(() => this.open.delete(name));
    return c;
  }
  async list() {
    return Promise.all((await this.names()).map(async n => {
      const c = await this.get(n, false);
      const cfg = c.config();
      const [turn, sessions, stats] = await Promise.all([c.turn(), c.sessions(), c.stats()]);
      return { name: n, title: cfg.title, description: cfg.description, profile: cfg.profile, turn: turn.holder,
        sessions: sessions.filter(s => s.state !== "left").map(s => ({ name: s.name, state: s.state, stale: s.stale, control: s.control })),
        stats };
    }));
  }
  async close() {
    for (const c of this.open.values()) await (await c.catch(() => null))?.close();
    this.open.clear();
    await (await this.shared?.catch(() => null))?.close();
    this.shared = null;
  }
}
