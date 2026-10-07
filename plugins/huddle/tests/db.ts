// tests/db.ts — a fresh SQLite file per test channel, closed by cleanup().
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Channel } from "../plugin/server/src/channel";
import { Store } from "../plugin/server/src/store";

const opened: Channel[] = [];

export const freshStore = () => Store.sqlite(`${mkdtempSync(`${tmpdir()}/huddle-`)}/t.db`);
export async function freshChannel(name = "t") {
  const ch = await Channel.open(name, await freshStore());
  opened.push(ch);
  return ch;
}
export async function cleanup() {
  for (const c of opened.splice(0)) await c.close().catch(() => {});
}
