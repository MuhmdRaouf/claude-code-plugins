// Node built-ins only: the ensure hook's bundle imports this and must stay tiny.
import net from "node:net";

/** True when something accepts a TCP connection on the loopback port within the budget. */
export function portAnswers(port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (answered: boolean): void => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(ms, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
