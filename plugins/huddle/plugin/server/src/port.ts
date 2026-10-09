// port.ts — Huddle has no fixed port. Each huddle home gets a random five-digit one the first time
// its server starts (10000–65535, free on this machine right now), saved in the home's huddle.json
// (bin/identity.ts) so later starts, join commands and the dashboard keep the same address.
import { createServer } from "node:net";

export const LOW = 10000, HIGH = 65535;

// nothing listens on port, on loopback or on every interface (binding is the only honest check)
const bindable = (port: number, host: string) => new Promise<boolean>(res => {
  const s = createServer();
  s.once("error", () => res(false));
  s.listen({ port, host, exclusive: true }, () => s.close(() => res(true)));
});
export const portFree = async (port: number) => await bindable(port, "127.0.0.1") && await bindable(port, "0.0.0.0");

// a random free port in LOW..HIGH; another try on each collision
export async function randomPort(tries = 200): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const p = LOW + Math.floor(Math.random() * (HIGH - LOW + 1));
    if (await portFree(p)) return p;
  }
  throw new Error(`no free port in ${LOW}-${HIGH} after ${tries} tries`);
}
