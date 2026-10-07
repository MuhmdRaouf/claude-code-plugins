// src/links.ts — which Claude Code session ids are which Huddle session (top-level name), per
// channel: learnt from the SessionStart join (its claude_session) and the approval hook, so
// Observatory's alerts and costs, which know Claude session ids only, land on Huddle names.
import { NAME_RE, OWNER, parentOf, type Channel } from "./channel";

const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
const ready = new WeakSet<Channel>();
async function ensure(ch: Channel) {
  if (ready.has(ch)) return;
  await ch.serial(() => ch.store.run("CREATE TABLE IF NOT EXISTS x_session_links (claude_id TEXT PRIMARY KEY, name TEXT NOT NULL, at TEXT NOT NULL)"));
  ready.add(ch);
}
export async function link(ch: Channel, name: string, claudeId: unknown) {
  const id = typeof claudeId === "string" ? claudeId : "";
  if (!/^[\w-]{1,128}$/.test(id) || !NAME_RE.test(name) || name === OWNER) return;
  const top = parentOf(name) ?? name;
  try {
    await ensure(ch);
    await ch.serial(() => ch.store.run("INSERT INTO x_session_links (claude_id, name, at) VALUES (?,?,?) ON CONFLICT(claude_id) DO UPDATE SET name=excluded.name, at=excluded.at", [id, top, iso(Date.now())]));
  } catch {}
}
export async function links(ch: Channel): Promise<Map<string, string>> {
  await ensure(ch);
  return new Map((await ch.store.all("SELECT claude_id, name FROM x_session_links")).map(r => [r.claude_id as string, r.name as string]));
}

