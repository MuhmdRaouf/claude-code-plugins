// provider-probe: one small request per Claude Code request feature, straight through the local provider router, to
// learn what the upstream (Z.ai's Anthropic-compatible endpoint) actually does with each feature: accepts it, ignores
// it, or rejects it. Reads the router's port from the shared registry the way the router itself does
// ($PROVIDER_ROUTERS_HOME, else ~/.agents/provider-routers/<name>.json) and talks to it like Claude Code does
// (POST /v1/messages, anthropic-version header, x-api-key placeholder — the router swaps auth for the provider key).
// Usage: node provider-probe.mjs [model]   (model default glm-5.3-flash; provider default zai)
// Prints one line per case: `case | http status | key facts`, and exits 0 even when cases fail (the table is the point).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Registry entry of `name`, or undefined when it has none (router not set up / not running). */
function readRegistryEntry(name) {
  const home = process.env.PROVIDER_ROUTERS_HOME ?? join(homedir(), ".agents", "provider-routers");
  try {
    const entry = JSON.parse(readFileSync(join(home, `${name}.json`), "utf8"));
    if (typeof entry?.port === "number" && entry.name === name) return entry;
  } catch {}
  return undefined;
}

const PROVIDER = process.argv[3] ?? "zai";
const MODEL = process.argv[2] ?? "glm-5.3-flash";
const entry = readRegistryEntry(PROVIDER);
if (entry === undefined) {
  console.error(`provider-probe: no registry entry for ${PROVIDER} (run the plugin's /setup first)`);
  process.exit(1);
}
const BASE = `http://127.0.0.1:${entry.port}`;
const TIMEOUT_MS = 120_000;

/** The one 1x1 transparent PNG, base64 (67 B). */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A tiny but structurally valid one-page PDF, built as a string, then base64. */
function tinyPdfBase64() {
  const objects = [
    "%PDF-1.4\n",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<<>>>>endobj\n",
    "4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 40 100 Td (probe) Tj ET\nendstream endobj\n",
  ];
  const body = objects.join("");
  const startxref = body.length;
  return Buffer.concat([
    Buffer.from(body, "latin1"),
    Buffer.from(
      `xref\n0 5\n0000000000 65535 f \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`,
      "latin1",
    ),
  ]).toString("base64");
}

/** `words` filler words, so a cache_control prefix clears any minimum cacheable length. */
function fillerWords(words) {
  return Array.from({ length: words }, (_, i) => `filler${i % 97}`).join(" ");
}

/** POST one Anthropic-shaped JSON request to the router; resolves {status, contentType, text}. */
async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "x",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text: await res.text() };
}

/** Error facts from a JSON error body (or raw text), first 120 chars. */
function errorFacts(text) {
  try {
    const json = JSON.parse(text);
    const type = json?.error?.type ?? json?.type ?? "?";
    const message = json?.error?.message ?? json?.message ?? text;
    return `error ${type}: ${String(message).slice(0, 120)}`;
  } catch {
    return `error: ${text.slice(0, 120)}`;
  }
}

/** Facts of a message answer: stop_reason, content block types, usage keys. */
function messageFacts(json) {
  const blocks = Array.isArray(json.content)
    ? json.content.map((b) => b.type).join("+") || "[]"
    : "(no content)";
  const usageKeys = json.usage ? Object.keys(json.usage).sort().join(",") : "(no usage)";
  const thinking =
    json.thinking !== undefined ? ` thinking=${JSON.stringify(json.thinking).slice(0, 60)}` : "";
  return `stop_reason=${json.stop_reason} blocks=[${blocks}] usage{${usageKeys}}${thinking}`;
}

/** Facts of a non-message answer (count_tokens): the keys and short values are the facts. */
function jsonFacts(json) {
  const fields = Object.entries(json)
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
    .join(" ");
  return `json{${String(fields).slice(0, 120)}}`;
}

/** Facts of a non-streaming answer: message facts, json facts, or error facts. */
function answerFacts(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return `non-JSON: ${text.slice(0, 120)}`;
  }
  if (json.type === "error" || json.error !== undefined) return errorFacts(text);
  if (json.stop_reason === undefined && json.content === undefined) return jsonFacts(json);
  return messageFacts(json);
}

/** Whether one SSE data line is a message_delta that carries a usage object. */
function deltaCarriesUsage(line) {
  if (!line.startsWith("data: ") || !line.includes("message_delta")) return false;
  try {
    const data = JSON.parse(line.slice(6));
    return data.usage !== undefined && Object.keys(data.usage).length > 0;
  } catch {
    return false;
  }
}

/** Facts of an SSE stream: the event types seen, whether message_delta carried usage. */
function streamFacts(text) {
  const types = [];
  let deltaUsage = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) types.push(line.slice(7).trim());
    if (deltaCarriesUsage(line)) deltaUsage = true;
  }
  const seen = [...new Set(types)].join(",");
  const sse = types.length > 0;
  return sse ? `events=[${seen}] message_delta.usage=${deltaUsage}` : `not SSE: ${text.slice(0, 120)}`;
}

/** The request every case starts from. */
const base = (extra) => ({
  model: MODEL,
  max_tokens: 64,
  messages: [{ role: "user", content: "Reply with OK." }],
  ...extra,
});

const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get the weather of a city.",
  input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

/** Every case: {name, path?, headers?, body} — or a whole-request override via `send`. */
const CASES = [
  { name: "a-plain", body: base() },
  { name: "b-stream", body: base({ stream: true }), stream: true },
  {
    name: "c-thinking-enabled",
    body: base({ thinking: { type: "enabled", budget_tokens: 1024 }, max_tokens: 2048 }),
  },
  { name: "d-thinking-adaptive", body: base({ thinking: { type: "adaptive" } }) },
  { name: "e-output-config-effort", body: base({ output_config: { effort: "low" } }) },
  {
    name: "f-tool-choice",
    body: base({
      tools: [WEATHER_TOOL],
      tool_choice: { type: "tool", name: "get_weather" },
      messages: [{ role: "user", content: "What is the weather in Paris?" }],
    }),
  },
  {
    name: "g-defer-loading",
    headers: { "anthropic-beta": "advanced-tool-use-2025-11-20" },
    body: base({
      tools: [{ ...WEATHER_TOOL, defer_loading: true }],
      messages: [{ role: "user", content: "What is the weather in Paris?" }],
    }),
  },
  {
    name: "h-tool-reference",
    body: base({
      tools: [WEATHER_TOOL],
      messages: [
        { role: "user", content: "What is the weather in Paris?" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_probe_1", name: "get_weather", input: { city: "Paris" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_probe_1",
              content: [{ type: "tool_reference", tool_name: "get_weather" }],
            },
          ],
        },
      ],
    }),
  },
  {
    name: "i-web-search",
    body: base({
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      messages: [{ role: "user", content: "Search the web for the current Z.ai catalog id of GLM 5.3." }],
    }),
  },
  {
    name: "j-web-fetch",
    body: base({
      tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
      messages: [{ role: "user", content: "Fetch https://example.com and say its title." }],
    }),
  },
  {
    name: "k-image",
    body: base({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1 } },
            { type: "text", text: "What do you see? One word." },
          ],
        },
      ],
    }),
  },
  {
    name: "l-document",
    body: base({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: tinyPdfBase64() },
            },
            { type: "text", text: "What does this PDF say? One word." },
          ],
        },
      ],
    }),
  },
  {
    name: "m-cache-1h",
    body: base({
      system: [{ type: "text", text: fillerWords(1100), cache_control: { type: "ephemeral", ttl: "1h" } }],
    }),
  },
  {
    name: "n-context-management",
    headers: { "anthropic-beta": "context-management-2025-06-27" },
    body: base({ context_management: { edits: [{ type: "clear_tool_uses_20250919" }] } }),
  },
  {
    name: "o-count-tokens",
    path: "/v1/messages/count_tokens",
    body: { model: MODEL, messages: [{ role: "user", content: "Reply with OK." }] },
  },
  { name: "p-max-tokens-200k", body: base({ max_tokens: 200_000 }) },
  {
    name: "q-tier-metadata-stop",
    body: base({ service_tier: "auto", metadata: { user_id: "probe" }, stop_sequences: ["zzz"] }),
  },
  {
    name: "r-unknown-beta",
    headers: { "anthropic-beta": "totally-unknown-beta-2099-01-01" },
    body: base(),
  },
];

/** The `case | status | facts` line for one sent case. */
function resultLine(c, r) {
  const facts =
    c.stream && r.status === 200
      ? streamFacts(r.text)
      : r.status >= 200 && r.status < 300
        ? answerFacts(r.text)
        : errorFacts(r.text);
  return `${c.name} | ${r.status} | ${facts}`;
}

/** One line per case, in order; a thrown case prints its error and never stops the run. */
async function main() {
  console.log(
    `# provider-probe provider=${PROVIDER} model=${MODEL} router=${BASE} ${new Date().toISOString()}`,
  );
  for (const c of CASES) {
    let line;
    try {
      line = resultLine(c, await post(c.path ?? "/v1/messages", c.body, c.headers ?? {}));
    } catch (err) {
      line = `${c.name} | - | threw ${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 120)}`;
    }
    console.log(line);
  }
}

main();
