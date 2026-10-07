// tests/net.ts — ports and servers for the tests, without the bind-close-reuse race. A server the
// test spawns itself listens on PORT=0 (any free port) and says which one it got; nothing is
// freed and reused in between. A port a test must name in advance (huddle up, a dead address)
// comes from freePort: a random one below every OS's ephemeral range (Linux 32768+, macOS 49152+),
// so no other socket is handed it by a port-0 bind meanwhile, checked free, never given out twice.
import { portFree } from "../plugin/server/src/port";
import type { Subprocess } from "bun";

const ROOT = `${import.meta.dir}/..`;
const given = new Set<number>();
export async function freePort(): Promise<number> {
  for (let i = 0; i < 500; i++) {
    const p = 20000 + Math.floor(Math.random() * 12000);
    if (given.has(p)) continue;
    given.add(p);
    if (await portFree(p)) return p;
  }
  throw new Error("no free port in 20000-31999");
}

/** Wait until f() is truthy (polled every 25 ms), up to ms; returns its value, or undefined. */
export async function until<T>(f: () => T | Promise<T>, ms = 8000): Promise<T | undefined> {
  for (const t = Date.now(); Date.now() - t < ms; await Bun.sleep(25)) { const v = await f(); if (v) return v; }
  return undefined;
}

/** The Huddle server from source on a port of its own (PORT=0), ready to answer: {p, port, u}. */
export async function startServer(env: Record<string, string | undefined> = {}, o: { stderr?: "inherit" | "ignore" } = {}): Promise<{ p: Subprocess; port: number; u: string }> {
  const p = Bun.spawn(["bun", `${ROOT}/plugin/server/server.ts`], { env: { ...process.env, ...env, PORT: "0" }, stdout: "pipe", stderr: o.stderr ?? "inherit" });
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader(), dec = new TextDecoder();
  let buf = "", port = 0;
  const deadline = Date.now() + 30_000;
  while (!port && Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true }))]);
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const m = /on http:\/\/[\d.]+:(\d+)/.exec(buf);
    if (m) port = Number(m[1]);
  }
  if (!port) { p.kill(); throw new Error(`server did not start: ${buf}`); }
  (async () => { try { for (;;) { const r = await reader.read(); if (r.done) break; } } catch {} })(); // drain the rest
  const u = `http://127.0.0.1:${port}`;
  if (!(await until(async () => { try { return (await fetch(`${u}/health`)).ok; } catch { return false; } }, 10_000))) { p.kill(); throw new Error("server did not answer /health"); }
  return { p, port, u };
}
