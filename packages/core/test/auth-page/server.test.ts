import { request } from "node:http";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AuthPage,
  type AuthPageOptions,
  MAX_BODY_BYTES,
  startAuthPage,
} from "../../src/auth-page/server.ts";
import type { KeyVerdict } from "../../src/ports/keys.ts";
import { TEST_KEY } from "../support/fake-keystore.ts";

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** One raw HTTP request, so the test controls Host, Origin and the body exactly as an attacker could. */
function send(
  url: string,
  init: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> {
  const target = new URL(url);
  return new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: target.port,
        method: init.method ?? "GET",
        path: init.path ?? target.pathname,
        headers: { host: target.host, ...init.headers },
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", fail);
    req.end(init.body);
  });
}

function csrfOf(html: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  if (match?.[1] === undefined) throw new Error("no csrf field");
  return match[1];
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** A well-formed POST from the page itself, overridable field by field. */
async function post(
  page: AuthPage,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const origin = new URL(page.url).origin;
  return send(page.url, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: form(fields),
  });
}

class Harness {
  verdicts: KeyVerdict[] = [];
  readonly checked: string[] = [];
  readonly saved: string[] = [];
  failSave = false;
  options(extra: Partial<AuthPageOptions> = {}): AuthPageOptions {
    return {
      display: "Z.ai GLM",
      billingUrl: "https://z.ai/manage-apikey/billing",
      storeLabel: "macOS Keychain",
      check: async (key) => {
        this.checked.push(key);
        return this.verdicts.shift() ?? "accepted";
      },
      save: async (key) => {
        if (this.failSave) throw new Error("could not store the key in macOS Keychain (exit 1)");
        this.saved.push(key);
      },
      ...extra,
    };
  }
}

let captured = "";
beforeEach(() => {
  captured = "";
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      captured += String(chunk);
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(captured).not.toContain(TEST_KEY);
});

const pages: AuthPage[] = [];
async function open(h: Harness, extra: Partial<AuthPageOptions> = {}): Promise<AuthPage> {
  const page = await startAuthPage(h.options({ timeoutMs: 30_000, ...extra }));
  pages.push(page);
  return page;
}

function expectSecurityHeaders(reply: Reply): void {
  expect(reply.headers["content-security-policy"]).toMatch(
    /^default-src 'none'; style-src 'nonce-[A-Za-z0-9+/=]+'; form-action 'self'; frame-ancestors 'none'$/,
  );
  expect(reply.headers["referrer-policy"]).toBe("no-referrer");
  expect(reply.headers["cache-control"]).toBe("no-store");
  expect(reply.headers["x-content-type-options"]).toBe("nosniff");
}

describe("the one-time key page", () => {
  it("serves one form at 127.0.0.1:<port>/<32-byte token> with the security headers and no scripts", async () => {
    const page = await open(new Harness());
    expect(page.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/);
    const reply = await send(page.url);
    expect(reply.status).toBe(200);
    expectSecurityHeaders(reply);
    const nonce = /'nonce-([^']+)'/.exec(String(reply.headers["content-security-policy"]))?.[1];
    expect(reply.body).toContain(`<style nonce="${nonce}">`);
    expect(reply.body).toContain('<input type="password" id="key" name="key" autocomplete="off"');
    expect(reply.body).toMatch(/name="csrf" value="[A-Za-z0-9_-]{43}"/);
    expect(reply.body).not.toMatch(/<script|https?:\/\/|@import|url\(/i);
    expect(reply.body).toContain("macOS Keychain");
  });

  it("anything but GET/POST /<token> with the exact Host is a 404 with an empty body", async () => {
    const page = await open(new Harness());
    const { host, pathname } = new URL(page.url);
    const cases = [
      { path: "/" },
      { path: `${pathname}x` },
      { path: `${pathname}?a=1` },
      { path: pathname.slice(0, -1) },
      { method: "PUT" },
      { method: "DELETE" },
      { headers: { host: `localhost${host.slice(host.indexOf(":"))}` } },
      { headers: { host: "attacker.example" } },
      { headers: { host: "127.0.0.1" } },
    ];
    for (const init of cases) {
      const reply = await send(page.url, init);
      expect(reply.status, JSON.stringify(init)).toBe(404);
      expect(reply.body).toBe("");
      expectSecurityHeaders(reply);
    }
  });

  it("refuses a POST without the page's Origin, content type, CSRF value or a small body, and stores nothing", async () => {
    const h = new Harness();
    const page = await open(h);
    const csrf = csrfOf((await send(page.url)).body);
    const good = { csrf, key: TEST_KEY };
    const noOrigin = await send(page.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form(good),
    });
    const replies = [
      [noOrigin, 403],
      [await post(page, good, { origin: "http://attacker.example" }), 403],
      [await post(page, good, { origin: "null" }), 403],
      [await post(page, good, { origin: new URL(page.url).origin.replace("127.0.0.1", "localhost") }), 403],
      [await post(page, good, { "content-type": "text/plain" }), 415],
      [await post(page, good, { "content-type": "multipart/form-data; boundary=x" }), 415],
      [await post(page, { key: TEST_KEY }), 403],
      [await post(page, { csrf: `${csrf.slice(1)}A`, key: TEST_KEY }), 403],
      [await post(page, { csrf: "short", key: TEST_KEY }), 403],
      [await post(page, { csrf, key: TEST_KEY, pad: "x".repeat(MAX_BODY_BYTES) }), 413],
    ] as const;
    for (const [reply, status] of replies) {
      expect(reply.status).toBe(status);
      expect(reply.body).toBe("");
      expectSecurityHeaders(reply);
    }
    expect(h.checked).toEqual([]);
    expect(h.saved).toEqual([]);
    // The page still works after all of that.
    expect((await post(page, good)).body).toContain("Saved. Return to Claude Code.");
    expect(h.saved).toEqual([TEST_KEY]);
  });

  it("an oversized body that lies about its length is cut off at 4 KiB", async () => {
    const h = new Harness();
    const page = await open(h);
    const csrf = csrfOf((await send(page.url)).body);
    const body = form({ csrf, key: TEST_KEY, pad: "y".repeat(MAX_BODY_BYTES * 4) });
    const reply = await send(page.url, {
      method: "POST",
      headers: {
        origin: new URL(page.url).origin,
        "content-type": "application/x-www-form-urlencoded",
        "transfer-encoding": "chunked",
      },
      body,
    }).catch(() => ({ status: 413, headers: {}, body: "" }));
    expect(reply.status).toBe(413);
    expect(h.saved).toEqual([]);
  });

  it("a refused key shows the error and keeps the form; the next good key is stored once and the server exits", async () => {
    const h = new Harness();
    h.verdicts = ["refused", "unknown"];
    const page = await open(h);
    const csrf = csrfOf((await send(page.url)).body);

    const refused = await post(page, { csrf, key: TEST_KEY });
    expect(refused.status).toBe(200);
    expect(refused.body).toContain("That key was refused. Try again.");
    expect(refused.body).toContain('name="csrf"');
    expect(refused.body).not.toContain(TEST_KEY);
    expectSecurityHeaders(refused);

    const unknown = await post(page, { csrf, key: TEST_KEY });
    expect(unknown.body).toContain("could not be checked right now");

    const malformed = await post(page, { csrf, key: "not a key!" });
    expect(malformed.body).toContain("does not look like an API key");
    expect(h.checked).toEqual([TEST_KEY, TEST_KEY]);

    const saved = await post(page, { csrf, key: `  ${TEST_KEY}  ` });
    expect(saved.body).toContain("Saved. Return to Claude Code.");
    expect(saved.body).not.toContain('name="csrf"');
    expect(await page.done).toBe("saved");
    expect(h.saved).toEqual([TEST_KEY]);
    await expect(send(page.url)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("a key the provider rate limits or has no balance for is stored, with the reason on the page", async () => {
    const h = new Harness();
    h.verdicts = ["limited"];
    const page = await open(h);
    const csrf = csrfOf((await send(page.url)).body);

    const saved = await post(page, { csrf, key: TEST_KEY });
    expect(saved.body).toContain("Saved, but Z.ai GLM is not taking requests with it yet");
    expect(saved.body).toContain("https://z.ai/manage-apikey/billing");
    expect(await page.done).toBe("saved");
    expect(h.saved).toEqual([TEST_KEY]);
  });

  it("five failed tries end the page", async () => {
    const h = new Harness();
    h.verdicts = ["refused", "refused", "refused", "refused", "refused"];
    const page = await open(h);
    const csrf = csrfOf((await send(page.url)).body);
    for (let i = 0; i < 4; i += 1)
      expect((await post(page, { csrf, key: TEST_KEY })).body).toContain("Try again.");
    const last = await post(page, { csrf, key: TEST_KEY });
    expect(last.body).toContain("That was the last try");
    expect(last.body).not.toContain('name="csrf"');
    expect(await page.done).toBe("refused");
    expect(h.saved).toEqual([]);
  });

  it("a key the store will not take is reported, not lost in a crash; a throwing check counts as unknown", async () => {
    const h = new Harness();
    h.failSave = true;
    const page = await open(h, {
      check: async () => {
        throw new Error(`boom ${TEST_KEY}`);
      },
    });
    const csrf = csrfOf((await send(page.url)).body);
    expect((await post(page, { csrf, key: TEST_KEY })).body).toContain("could not be checked right now");
    const failing = await open(h);
    const csrf2 = csrfOf((await send(failing.url)).body);
    const reply = await post(failing, { csrf: csrf2, key: TEST_KEY });
    expect(reply.body).toContain("accepted but could not be saved in macOS Keychain");
    expect(reply.body).not.toContain(TEST_KEY);
  });

  it("a second POST while the first is being checked is turned away", async () => {
    const h = new Harness();
    let release: (() => void) | undefined;
    const page = await open(h, {
      check: () =>
        new Promise<KeyVerdict>((resolve) => {
          release = () => resolve("accepted");
        }),
    });
    const csrf = csrfOf((await send(page.url)).body);
    const first = post(page, { csrf, key: TEST_KEY });
    await vi.waitFor(() => expect(release).toBeDefined());
    const second = await post(page, { csrf, key: TEST_KEY });
    expect(second.status).toBe(409);
    release?.();
    expect((await first).body).toContain("Saved.");
    expect(h.saved).toEqual([TEST_KEY]);
  });

  it("a request that is not HTTP gets its connection closed", async () => {
    const page = await open(new Harness());
    const socket = connect(Number(new URL(page.url).port), "127.0.0.1");
    socket.end("NOT HTTP\r\n\r\n");
    const closed = await new Promise<string>((resolve) => {
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("close", () => resolve(data));
    });
    expect(closed).toBe("");
  });

  it("exits on its own after the timeout", async () => {
    const page = await open(new Harness(), { timeoutMs: 50 });
    expect(await page.done).toBe("timeout");
    await expect(send(page.url)).rejects.toThrow(/ECONNREFUSED/);
  });
});

afterEach(() => {
  for (const page of pages.splice(0)) page.close();
});
