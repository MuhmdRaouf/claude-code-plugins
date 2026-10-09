// The passthrough the front serves itself when its worker will not stay up, and the emergency process serves when
// the main router cannot start at all: every request that is not for this provider's models goes to Anthropic exactly
// as it came (method, path, query, headers minus hop-by-hop, body, the caller's own credentials, the streamed answer
// and its status); a provider-model request gets an Anthropic-shaped 503 that says what to run. A body that does not
// parse, or names no model, is Anthropic's: never block on it. Node built-ins only, independent of router.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import { claims, type ModelClaim } from "../domain/provider.ts";
import {
  anthropicError,
  forwardHeaders,
  type ProxyEnv,
  requestModel,
  safePath,
  sendUpstream,
  upstreamUrl,
} from "./upstream.ts";

/** What the passthrough needs to know: whose models to refuse, and how to word the refusal. */
export interface PassthroughOptions {
  /** The plugin's short name, as in `/<name>:setup`. */
  readonly name: string;
  /** The provider as people know it, e.g. "Z.ai GLM". */
  readonly display: string;
  /** The model ids this provider claims (refused here); every other request is Anthropic's. */
  readonly claim: ModelClaim;
  /** Where every other request goes: https://api.anthropic.com unless overridden. */
  readonly anthropic: URL;
  readonly env: ProxyEnv;
  /** Why provider models are refused: "degraded after repeated crashes" or "in emergency passthrough". */
  readonly state: string;
  readonly idleMs?: number;
  readonly log?: (line: string) => void;
}

/** The 503 a provider-model request gets while the router is not fully up. */
export function degradedMessage(options: Pick<PassthroughOptions, "name" | "display" | "state">): string {
  return `${options.display} router ${options.state}; Claude models still work. Run /${options.name}:setup.`;
}

/** Serves one request whose body has already been read. */
export function passThrough(
  options: PassthroughOptions,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): void {
  const path = safePath(req.url);
  if (path === undefined) {
    anthropicError(res, 400, "invalid_request_error", "bad request path");
    return;
  }
  const model = requestModel(body);
  if (claims(options.claim, model)) {
    options.log?.(`${req.method} ${path} model=${model} → refused (${options.state})`);
    anthropicError(res, 503, "api_error", degradedMessage(options));
    return;
  }
  const url = upstreamUrl(options.anthropic, path);
  sendUpstream(
    {
      url,
      method: req.method ?? "POST",
      headers: forwardHeaders(req.headers, url, body.length),
      body,
      env: options.env,
      ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    },
    res,
    {
      answered: (answer) =>
        options.log?.(
          `${req.method} ${path} model=${model || "-"} → anthropic ${answer.statusCode} (passthrough)`,
        ),
      failed: ({ code, afterHeaders }) => {
        options.log?.(`${req.method} ${path} model=${model || "-"} → anthropic error ${code} (passthrough)`);
        if (!afterHeaders)
          anthropicError(res, 502, "api_error", `${options.name} router: anthropic unreachable (${code})`);
      },
    },
  );
}
