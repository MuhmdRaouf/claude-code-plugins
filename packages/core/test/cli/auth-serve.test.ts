import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkKey } from "../../src/auth-page/check.ts";
import { EXIT } from "../../src/cli/exit.ts";
import { runCli } from "../../src/cli/run.ts";
import { TEST_KEY } from "../support/fake-keystore.ts";
import { fakeDeps } from "../support/fakes.ts";
import { listen } from "../support/net.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";

interface Seen {
  readonly path: string | undefined;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** A provider endpoint answering `status`, recording what it was sent. */
async function fakeProvider(status: () => number): Promise<{ base: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      seen.push({ path: req.url, authorization: req.headers.authorization, body });
      res.writeHead(status(), { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const port = await listen(server);
  servers.push(server);
  return { base: `http://127.0.0.1:${port}/api/anthropic/`, seen, server };
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function provider(base: string) {
  return { ...REFERENCE_PROVIDER, baseUrl: { intl: base } };
}

describe("checkKey", () => {
  it("sends one minimal ping-tier request with the key as a Bearer token", async () => {
    const endpoint = await fakeProvider(() => 200);
    expect(await checkKey(provider(endpoint.base), TEST_KEY)).toBe("accepted");
    expect(endpoint.seen).toEqual([
      {
        path: "/api/anthropic/v1/messages",
        authorization: `Bearer ${TEST_KEY}`,
        body: JSON.stringify({
          model: "glm-5.3-flash",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      },
    ]);
  });

  it("401 and 403 are refused; 429 and 402 are a known key held back; anything else or no answer is unknown", async () => {
    let status = 401;
    const endpoint = await fakeProvider(() => status);
    const verdict = () => checkKey(provider(endpoint.base), TEST_KEY);
    expect(await verdict()).toBe("refused");
    status = 403;
    expect(await verdict()).toBe("refused");
    for (status of [429, 402]) expect(await verdict()).toBe("limited");
    for (status of [400, 500]) expect(await verdict()).toBe("unknown");
    endpoint.server.close();
    expect(await checkKey(provider("http://127.0.0.1:1"), TEST_KEY)).toBe("unknown");
  });
});

function postKey(url: string, key: string): Promise<string> {
  const target = new URL(url);
  return new Promise((done, fail) => {
    // The form's CSRF value comes from the page itself.
    request(url, { agent: false }, (page) => {
      let html = "";
      page.on("data", (chunk: Buffer) => {
        html += chunk.toString();
      });
      page.on("end", () => {
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
        const req = request(
          url,
          {
            method: "POST",
            agent: false,
            headers: { origin: target.origin, "content-type": "application/x-www-form-urlencoded" },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk: Buffer) => {
              body += chunk.toString();
            });
            res.on("end", () => done(body));
          },
        );
        req.on("error", fail);
        req.end(new URLSearchParams({ csrf, key }).toString());
      });
    })
      .on("error", fail)
      .end();
  });
}

describe("auth-serve", () => {
  it("prints only the URL, checks the key, stores it (the key file in a sandbox HOME) and exits 0", async () => {
    const endpoint = await fakeProvider(() => 200);
    const home = tempDir();
    const fakes = fakeDeps([], { HOME: home }, { provider: provider(endpoint.base) });
    const exit = runCli(["auth-serve"], fakes.deps, "/repo");
    await expect.poll(() => fakes.out.lines.length).toBe(1);
    const url = fakes.out.lines[0] ?? "";
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/);
    expect(await postKey(url, TEST_KEY)).toContain("Saved.");
    expect(await exit).toBe(EXIT.ok);
    const file = join(home, ".config/zai-plugin-cc/env");
    expect(readFileSync(file, "utf8")).toBe(`ZAI_API_KEY=${TEST_KEY}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(fakes.out.lines).toEqual([url]);
    expect(fakes.out.errors).toEqual([]);
  });

  it("exits 6 when the page ends without a key", async () => {
    const endpoint = await fakeProvider(() => 401);
    const fakes = fakeDeps([], { HOME: tempDir() }, { provider: provider(endpoint.base) });
    const exit = runCli(["auth-serve"], fakes.deps, "/repo");
    await expect.poll(() => fakes.out.lines.length).toBe(1);
    const url = fakes.out.lines[0] ?? "";
    for (let i = 0; i < 5; i += 1) await postKey(url, TEST_KEY);
    expect(await exit).toBe(EXIT.notReady);
    expect([...fakes.out.lines, ...fakes.out.errors].join("\n")).not.toContain(TEST_KEY);
  });
});
