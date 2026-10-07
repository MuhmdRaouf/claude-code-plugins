// The one-time key page: 127.0.0.1 on an OS-chosen port, at /<token> only. Every request must name the exact host
// (DNS rebinding), every POST the exact origin, the form content type, a small body and the form's CSRF value. The key
// is checked with one request, stored, and the server exits; it also exits after 10 minutes or 5 failed tries.
// Nothing here logs: not requests, not bodies, not the key.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isValidKey } from "../adapters/keystore/index.ts";
import type { KeyVerdict } from "../ports/keys.ts";
import { type PageView, renderPage } from "./html.ts";

const PAGE_TIMEOUT_MS = 10 * 60_000;
const MAX_TRIES = 5;
export const MAX_BODY_BYTES = 4096;
const FORM_TYPE = "application/x-www-form-urlencoded";

export interface AuthPageOptions {
  readonly display: string;
  /** Where the provider takes a top-up, named when it knows the key but will not serve it yet. */
  readonly billingUrl: string;
  /** Where the key will live, named on the page. */
  readonly storeLabel: string;
  /** One minimal provider request with the candidate key. */
  check(key: string): Promise<KeyVerdict>;
  /** Stores an accepted key; throws (without the key in the message) when the store refuses it. */
  save(key: string): Promise<void>;
  readonly timeoutMs?: number;
  readonly maxTries?: number;
}

/** saved: a key was checked and stored. timeout: nobody finished in time. refused: too many failed tries. closed:
 *  the user closed the page. */
type AuthOutcome = "saved" | "timeout" | "refused" | "closed";

export interface AuthPage {
  /** http://127.0.0.1:<port>/<token>: the token is the only secret in it. */
  readonly url: string;
  readonly done: Promise<AuthOutcome>;
  /** Ends the page now (outcome `closed`). */
  close(): void;
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

/** A per-response CSP nonce. */
function nonce(): string {
  return randomBytes(16).toString("base64");
}

function sameSecret(given: string | null | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function headers(nonce: string): Record<string, string> {
  return {
    "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

/** An empty-bodied refusal; the connection closes so an oversized upload is not read on. */
function refuse(res: ServerResponse, status: number): void {
  res.writeHead(status, { ...headers(nonce()), "Content-Length": "0", Connection: "close" });
  res.end();
}

/** The request body when it fits in `max` bytes, else undefined (and the rest is not read). */
function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (!Number.isFinite(declared) || declared > max) return Promise.resolve(undefined);
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.removeAllListeners("data");
        req.pause();
        done(undefined);
      } else chunks.push(chunk);
    });
    req.on("end", () => done(size > max ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => done(undefined));
  });
}

export async function startAuthPage(options: AuthPageOptions): Promise<AuthPage> {
  const token = secret();
  const csrf = secret();
  const maxTries = options.maxTries ?? MAX_TRIES;
  const view = { display: options.display, storeLabel: options.storeLabel };
  let port = 0;
  let tries = 0;
  let busy = false;
  let finished = false;
  let settle: (outcome: AuthOutcome) => void = () => undefined;
  const done = new Promise<AuthOutcome>((resolve) => {
    settle = resolve;
  });

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) refuse(res, 500);
      else res.destroy();
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  const timer = setTimeout(() => finish("timeout"), options.timeoutMs ?? PAGE_TIMEOUT_MS);

  function finish(outcome: AuthOutcome): void {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    settle(outcome);
  }

  function page(res: ServerResponse, pageView: PageView, after?: AuthOutcome): void {
    const styleNonce = nonce();
    const body = renderPage(pageView, styleNonce);
    res.writeHead(200, {
      ...headers(styleNonce),
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body)),
    });
    if (after !== undefined) res.on("finish", () => finish(after));
    res.end(body);
  }

  /** GET or POST for a request that may go on, else the refusal's status. Exact Host (no DNS rebinding), exact path,
   *  and for a POST the page's own Origin and the form content type. */
  function admit(req: IncomingMessage): "GET" | "POST" | number {
    const host = `127.0.0.1:${port}`;
    if (finished || req.headers.host !== host || !sameSecret(req.url, `/${token}`)) return 404;
    if (req.method === "GET") return "GET";
    if (req.method !== "POST") return 404;
    if (req.headers.origin !== `http://${host}`) return 403;
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    return type === FORM_TYPE ? "POST" : 415;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const admitted = admit(req);
    if (admitted === "GET") return page(res, { ...view, csrf });
    if (admitted !== "POST") return refuse(res, admitted);
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === undefined) return refuse(res, 413);
    const form = new URLSearchParams(body);
    if (!sameSecret(form.get("csrf"), csrf)) return refuse(res, 403);
    return submitAlone(res, (form.get("key") ?? "").trim());
  }

  /** One submission at a time: a second one while a key is being checked is turned away. */
  async function submitAlone(res: ServerResponse, key: string): Promise<void> {
    if (busy || finished) return refuse(res, 409);
    busy = true;
    try {
      await submit(res, key);
    } finally {
      busy = false;
    }
  }

  async function submit(res: ServerResponse, key: string): Promise<void> {
    const tried = await attempt(key);
    if (tried.saved) return page(res, { ...view, message: { kind: "done", text: tried.text } }, "saved");
    const failure = tried.text;
    tries += 1;
    if (tries >= maxTries) {
      const text = `${failure} That was the last try: run setup again in Claude Code for a new page.`;
      return page(res, { ...view, message: { kind: "error", text } }, "refused");
    }
    page(res, { ...view, csrf, message: { kind: "error", text: `${failure} Try again.` } });
  }

  /** Whether the key was stored, and what to tell the user either way (never the key). */
  async function attempt(key: string): Promise<{ readonly saved: boolean; readonly text: string }> {
    const refuse = (text: string) => ({ saved: false, text });
    if (!isValidKey(key))
      return refuse("That does not look like an API key (16-512 letters, digits, '.', '_' or '-').");
    const verdict = await options.check(key).catch((): KeyVerdict => "unknown");
    if (verdict === "refused") return refuse("That key was refused.");
    if (verdict === "unknown") return refuse("The key could not be checked right now.");
    try {
      await options.save(key);
    } catch {
      return refuse(`The key was accepted but could not be saved in ${options.storeLabel}.`);
    }
    return {
      saved: true,
      text:
        verdict === "limited"
          ? `Saved, but ${options.display} is not taking requests with it yet (a rate limit, or no balance left: top up at ${options.billingUrl}). Return to Claude Code.`
          : "Saved. Return to Claude Code.",
    };
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/${token}`, done, close: () => finish("closed") };
}
