import { describe, expect, it } from "vitest";
import { ZERO_TOKENS } from "../../src/shared/model.ts";
import { ModelsView } from "../../src/ui/app/views/Models.tsx";
import type { ClientState } from "../../src/ui/state.ts";
import { makeRequest } from "../helpers.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_790_000_000_000;

const MODELS: ClientState["models"] = {
  models: [
    {
      model: "glm-5.3",
      provider: "Z.ai",
      requests: 3,
      errors: 0,
      tokens: { ...ZERO_TOKENS, output: 900 },
      latencyP50: 120,
    },
    {
      model: "claude-sonnet-5-5",
      provider: "Anthropic",
      requests: 5,
      errors: 1,
      tokens: { ...ZERO_TOKENS, input: 400 },
      latencyP50: 45,
    },
  ],
  upstreams: [
    {
      upstream: "https://api.anthropic.com",
      host: "api.anthropic.com",
      requests: 5,
      tokens: { ...ZERO_TOKENS },
    },
  ],
  tools: [],
};

/** The models tables as the tab's scoped fetch holds them for the default scope (`range=1h|`). */
const SCOPED: ClientState["modelsScoped"] = { key: "range=1h|", data: MODELS };

function texts(root: Element, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((node) => node.textContent ?? "");
}

/** The style attribute as the DOM serialises it (happy-dom adds a space after each colon and semicolon). */
function styles(root: Element, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((node) => node.getAttribute("style") ?? "");
}

/** The third panel's subtitle ("Requests per bucket, …"). */
function rateSubtitle(root: Element): string {
  return [...root.querySelectorAll("section h2")][2]?.nextElementSibling?.textContent ?? "";
}

describe("ModelsView", () => {
  it("ranks models with token bars, then upstreams and a request-rate chart", () => {
    const { container } = renderApp(<ModelsView />, { modelsScoped: SCOPED });
    expect(texts(container, "section h2")).toEqual(["Models", "Upstreams", "Request rate"]);
    const metasOf = [...container.querySelectorAll("section h2")].map(
      (h) => h.nextElementSibling?.textContent ?? "",
    );
    expect(metasOf).toEqual(["2 models, tokens by kind", "1 endpoint", "Requests per bucket, 1 min per bar"]);
    expect(texts(container, "[data-rank-name]")).toEqual(["Sonnet 5.5", "GLM 5.3", "api.anthropic.com"]);
    expect(texts(container, "[data-rank-provider]")).toEqual(["Anthropic", "Z.ai"]);
    expect(texts(container, "[data-rank-meta]")).toEqual([
      "5 requests, median 45ms, unpriced",
      "3 requests, median 120ms, unpriced",
      "5 requests, unpriced",
    ]);
    expect(texts(container, "[data-rank-total]")).toEqual(["400", "900", "0"]);
    expect(texts(container, ".badge")).toEqual(["1 failed"]);
    expect(container.querySelector('section [aria-label="Token kinds"]')).not.toBeNull();
    expect(texts(container, '[aria-label="Token kinds"] li')).toEqual([
      "Input",
      "Output",
      "Cache read",
      "Cache write",
    ]);
    expect(container.querySelectorAll("#rate-gradient")).toHaveLength(1);
    expect(container.querySelector(".chart-ymax")?.textContent).toBe("0 max");
  });

  it("waits for its own scoped fetch and shows the failure when it has nothing else", () => {
    const waiting = renderApp(<ModelsView />, { models: MODELS });
    // the snapshot's fleet-wide copy is not the tab's scope: without the scoped answer it waits
    expect(waiting.container.querySelectorAll("section h2")).toHaveLength(1);
    expect(texts(waiting.container, ".empty-title")).toEqual(["Waiting for model totals"]);
    waiting.unmount();
    const failed = renderApp(<ModelsView />, {
      modelsError: "GET /api/models → 503",
    });
    expect(texts(failed.container, '[role="alert"]')).toEqual([
      "The model tables did not answer (GET /api/models → 503). Refresh to try again.",
    ]);
  });

  it("keeps a requests bar next to the token bar for each model", () => {
    const { container } = renderApp(<ModelsView />, { modelsScoped: SCOPED });
    const pairs = container.querySelectorAll("[data-bar-pair]");
    expect(pairs).toHaveLength(2);
    const [first, second] = pairs;
    expect(texts(first ?? container, "[data-bar-label]")).toEqual(["Requests", "Tokens"]);
    expect(styles(first ?? container, ".bar-seg")).toEqual([
      "width: 100.00%; background: var(--series-4);",
      "width: 44.44%; background: var(--series-1);",
    ]);
    expect(styles(second ?? container, ".bar-seg")).toEqual([
      "width: 60.00%; background: var(--series-1);",
      "width: 100.00%; background: var(--series-2);",
    ]);
  });

  it("charts the request rate from memory while the requests in memory reach across the window", () => {
    const { container } = renderApp(
      <ModelsView />,
      {
        range: { preset: "5m", from: 0, to: null },
        modelsScoped: { key: "range=5m|", data: { models: [], upstreams: [], tools: [] } },
        requests: [
          makeRequest({ id: "old", ts: NOW - 301_000 }),
          makeRequest({ id: "a", ts: NOW - 30_000 }),
          makeRequest({ id: "b", ts: NOW - 30_000 }),
          makeRequest({ id: "c", ts: NOW - 90_000 }),
        ],
      },
      NOW,
    );
    expect(rateSubtitle(container)).toBe("Requests per bucket, 5 s per bar");
    expect(container.querySelector(".chart-ymax")?.textContent).toBe("2 max");
    expect(container.querySelector(".mark-start")?.textContent).toBe("5 min ago");
    expect(container.querySelector(".mark-end")?.textContent).toBe("now");
    expect(container.querySelectorAll(".chart-line")).toHaveLength(1);
  });

  it("draws a skeleton, never the memory slice, while a history-only range waits for its answer", () => {
    // memory holds only the last 90 seconds, so the 5m window is the history route's to answer
    const { container } = renderApp(
      <ModelsView />,
      {
        range: { preset: "5m", from: 0, to: null },
        modelsScoped: { key: "range=5m|", data: { models: [], upstreams: [], tools: [] } },
        requests: [makeRequest({ id: "a", ts: NOW - 30_000 }), makeRequest({ id: "b", ts: NOW - 90_000 })],
      },
      NOW,
    );
    expect(rateSubtitle(container)).toBe("Requests per bucket, 5 s per bar");
    expect(container.querySelector('[role="status"][aria-label="Loading request rate"]')).not.toBeNull();
    expect(container.querySelectorAll(".chart-line")).toHaveLength(0);
  });

  it("says the history-fed chart counts every session while sessions are picked", () => {
    const { container } = renderApp(
      <ModelsView />,
      {
        range: { preset: "5m", from: 0, to: null },
        selected: ["s1"],
        modelsScoped: { key: "range=5m|s1", data: { models: [], upstreams: [], tools: [] } },
        requests: [makeRequest({ id: "a", ts: NOW - 30_000 })],
      },
      NOW,
    );
    expect(rateSubtitle(container)).toBe("Requests per bucket, 5 s per bar, every session");
    // the memory path scopes by the pick, so the label only joins when history serves the window
    const memory = renderApp(
      <ModelsView />,
      {
        range: { preset: "5m", from: 0, to: null },
        selected: ["s1"],
        modelsScoped: { key: "range=5m|s1", data: { models: [], upstreams: [], tools: [] } },
        requests: [makeRequest({ id: "old", ts: NOW - 301_000 }), makeRequest({ id: "a", ts: NOW - 30_000 })],
      },
      NOW,
    );
    expect(rateSubtitle(memory.container)).toBe("Requests per bucket, 5 s per bar");
  });

  it("draws the history answer for the range once it lands", () => {
    const { container } = renderApp(
      <ModelsView />,
      {
        range: { preset: "5m", from: 0, to: null },
        modelsScoped: { key: "range=5m|", data: { models: [], upstreams: [], tools: [] } },
        // a request only minutes old keeps memory from reaching the window's start, so the answer counts
        requests: [makeRequest({ id: "a", ts: NOW - 30_000 })],
        flow: {
          key: "range=5m",
          series: {
            from: NOW - 300_000,
            to: NOW,
            bucketMs: 5_000,
            requests: [1, 2],
            kinds: { input: [1, 2], output: [0, 0], cacheRead: [0, 0], cacheWrite: [0, 0] },
          },
        },
      },
      NOW,
    );
    expect(container.querySelector(".chart-ymax")?.textContent).toBe("2 max");
    expect(container.querySelectorAll(".chart-line")).toHaveLength(1);
  });

  it("names a failed history answer instead of drawing any substitute", () => {
    const { container } = renderApp(
      <ModelsView />,
      {
        range: { preset: "7d", from: 0, to: null },
        modelsScoped: { key: "range=7d|", data: { models: [], upstreams: [], tools: [] } },
        flowError: "GET /api/history/flow → 503",
      },
      NOW,
    );
    expect(texts(container, '[role="alert"]')).toEqual([
      "History did not answer for this range (GET /api/history/flow → 503). Narrow the range or check the history store.",
    ]);
    expect(container.querySelectorAll(".chart-line")).toHaveLength(0);
  });

  it("names an upstream by the host the wire carries, the empty one included", () => {
    const models: ClientState["models"] = {
      models: [],
      upstreams: [
        {
          upstream: "http://127.0.0.1:8787/v1",
          host: "somewhere-else.example",
          requests: 2,
          tokens: { ...ZERO_TOKENS, cacheRead: 40 },
        },
        {
          upstream: "",
          host: "Claude Code direct (no router)",
          requests: 1,
          tokens: { ...ZERO_TOKENS },
        },
      ],
      tools: [],
    };
    const { container } = renderApp(<ModelsView />, {
      modelsScoped: { key: "range=1h|", data: models },
    });
    // the server's host column names the row (a URL upstream is not re-derived, "" is not a bare dash)
    expect(texts(container, "[data-rank-name]")).toEqual([
      "somewhere-else.example",
      "Claude Code direct (no router)",
    ]);
  });

  it("notes empty lists once the scoped answer is in", () => {
    const bare = renderApp(<ModelsView />, {
      modelsScoped: { key: "range=1h|", data: { models: [], upstreams: [], tools: [] } },
    });
    expect(texts(bare.container, ".empty-title")).toEqual(["No model requests yet", "No upstreams recorded"]);
  });
});
