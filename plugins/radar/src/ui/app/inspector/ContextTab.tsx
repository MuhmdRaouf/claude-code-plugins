/**
 * The inspector's Context tab: the conversation as the model saw it at this request, rebuilt on the server
 * from the stored sides of the agent's earlier requests. Every turn is a collapsed row — role, kind, size,
 * first line — that opens into its blocks; the totals are a small stats strip and earlier pages load on
 * demand. Above the messages sits the prompt the request itself carried — its system prompt and tool
 * definitions, as the router captured them — collapsed by default, with the response headers it answered
 * under.
 */

import { Fragment } from "preact";
import type { RequestRecord } from "../../../shared/model.ts";
import { fmtBytes, fmtCount, fmtNum } from "../../fmt.ts";
import type {
  CapturedTool,
  CaptureState,
  ContentBlock,
  ContextMessage,
  ContextState,
  ContextTotals,
} from "../../state.ts";
import { Block } from "../Content.tsx";
import { useApp } from "../context.ts";
import { Code } from "../kit.tsx";
import { captureSystemText, captureToolName, captureTools, firstLine, prettyJson } from "./util.ts";

/** The skeleton of the shape the conversation renders in, while the server rebuilds it. */
function ContextLoading() {
  return (
    <div class="flex flex-col gap-3" role="status">
      <span class="sr-only">Rebuilding the conversation…</span>
      <div class="skeleton h-4 w-3/5" />
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div class="skeleton h-9" key={row} />
      ))}
    </div>
  );
}

/** The header numbers: how many turns, roughly how many tokens, how much of it was cache. */
function Totals({ totals }: { totals: ContextTotals }) {
  const usage = totals.usage;
  const contextTokens = usage === null ? null : usage.input + usage.cacheRead + usage.cacheWrite;
  return (
    <div class="stats stats-vertical max-w-full shrink-0 overflow-x-auto panel w-full sm:stats-horizontal">
      <div class="stat">
        <span class="stat-title">Turns</span>
        <span class="stat-value num text-base">{fmtCount(totals.messages, "message")}</span>
      </div>
      <div class="stat">
        <span class="stat-title">From stored text</span>
        <span class="stat-value num text-base">≈ {fmtNum(totals.approxTokens)}</span>
        <span class="stat-desc whitespace-normal">
          tokens
          {contextTokens !== null && contextTokens > 0 ? `, ${fmtNum(contextTokens)} reported` : ""}
        </span>
      </div>
      <div class="stat">
        <span class="stat-title">Cache</span>
        <span class="stat-value num text-base">{usage === null ? "–" : fmtNum(totals.cacheTokens)}</span>
        <span class="stat-desc whitespace-normal">
          {usage === null
            ? "No usage reported for this request"
            : `of it (read ${fmtNum(usage.cacheRead)}, written ${fmtNum(usage.cacheWrite)})`}
        </span>
      </div>
    </div>
  );
}

/** One turn: a collapsed row — role, kind, size, first line — opening into the blocks the side stored. */
function Message({ message }: { message: ContextMessage }) {
  return (
    <details class="ctx-msg collapse collapse-arrow panel">
      <summary class="collapse-title">
        <span class="flex min-w-0 items-center gap-2">
          <span class={`badge badge-sm ${message.role === "user" ? "badge-info" : "badge-success"} shrink-0`}>
            {message.role}
          </span>
          <Code text={message.kind} class="shrink-0 text-meta muted" />
          <span class="badge badge-ghost badge-sm num shrink-0">{fmtBytes(message.bytes)}</span>
          <span class="min-w-0 flex-1 truncate text-row">{firstLine(message.preview)}</span>
        </span>
      </summary>
      <div class="collapse-content flex flex-col gap-3">
        {message.blocks.map((block, at) => (
          <Block key={at} block={block as ContentBlock} />
        ))}
      </div>
    </details>
  );
}

/** A failed read as the design's alert-error, with the cause when the server named one. */
export function ErrorAlert({ words, cause }: { words: string; cause: string | undefined }) {
  return (
    <div role="alert" class="alert alert-error">
      <span>
        {words}
        {cause === undefined ? "." : `: ${cause}`}
      </span>
    </div>
  );
}

/** The captured response headers as a small key/value list — the few the allow-list lets through. */
function CaptureHeaders({ headers }: { headers: Record<string, string> }) {
  return (
    <div class="flex flex-col gap-1">
      <span class="text-meta muted">Answered under</span>
      {Object.entries(headers).map(([name, value]) => (
        <div class="flex min-w-0 gap-2 text-meta" key={name}>
          <Code text={name} class="shrink-0 muted" />
          <span class="min-w-0 break-all text-row">{value}</span>
        </div>
      ))}
    </div>
  );
}

/** One captured tool: its name and description on the collapsed row, its input schema in a collapsed pre. */
function CapturedToolRow({ tool }: { tool: CapturedTool }) {
  const description = typeof tool.description === "string" ? tool.description : "";
  const schema = tool.input_schema;
  return (
    <details class="collapse collapse-arrow panel">
      <summary class="collapse-title">
        <span class="flex min-w-0 items-center gap-2">
          <Code text={captureToolName(tool)} class="shrink-0 text-row" />
          <span class="min-w-0 flex-1 truncate text-meta muted">{firstLine(description)}</span>
        </span>
      </summary>
      <div class="collapse-content flex flex-col gap-3">
        {description !== "" && <p class="m-0 whitespace-pre-wrap text-row">{description}</p>}
        {schema !== undefined && schema !== null && (
          <Code text={prettyJson(schema)} class="whitespace-pre-wrap text-meta" />
        )}
      </div>
    </details>
  );
}

/** The prompt the request carried, collapsed by default: its size and tool count on the row; the system
 *  prompt text, each tool and the response headers inside. A request without a capture renders nothing. */
function PromptCapture({ capture }: { capture: CaptureState | undefined }) {
  if (capture === undefined || capture.status === "loading") {
    return (
      <p class="m-0 text-meta muted" role="status">
        Reading the captured prompt…
      </p>
    );
  }
  if (capture.status === "missing") return null;
  if (capture.status === "error") {
    return (
      <ErrorAlert
        words="The captured prompt could not be read; opening the tab again retries"
        cause={capture.cause}
      />
    );
  }
  const tools = captureTools(capture.tools);
  const system = captureSystemText(capture.system);
  return (
    <details class="collapse collapse-arrow panel">
      <summary class="collapse-title">
        <span class="flex min-w-0 flex-wrap items-center gap-2">
          <span class="shrink-0 text-sm font-medium">System prompt and tools</span>
          <span class="badge badge-ghost badge-sm num">{fmtBytes(capture.bytes)}</span>
          <span class="badge badge-ghost badge-sm num">{fmtCount(tools.length, "tool")}</span>
        </span>
      </summary>
      <div class="collapse-content flex flex-col gap-3">
        {system !== "" && <pre class="m-0 whitespace-pre-wrap text-row">{system}</pre>}
        {tools.map((tool, at) => (
          <CapturedToolRow key={at} tool={tool} />
        ))}
        {capture.headers !== null && <CaptureHeaders headers={capture.headers} />}
      </div>
    </details>
  );
}

/** The states the rebuilt conversation can arrive in, then its turns — with the prompt the request
 *  carried above them whenever the router captured one. */
export function ContextTab({ request }: { request: RequestRecord }) {
  const { state, act } = useApp();
  const held: ContextState | undefined = state.context[request.id];
  const capture: CaptureState | undefined = state.capture[request.id];
  if (held === undefined || held.status === "loading") return <ContextLoading />;
  if (held.status === "missing") {
    return (
      <div class="flex flex-col gap-5">
        <p class="m-0 text-row muted">
          Not in the history store: older than retention, or captured before history was on. The conversation
          cannot be rebuilt for this request.
        </p>
      </div>
    );
  }
  if (held.status === "off") {
    return (
      <div class="flex flex-col gap-5">
        <p class="m-0 text-row muted">History is off, so the conversation cannot be rebuilt.</p>
      </div>
    );
  }
  if (held.status === "error") {
    return (
      <div class="flex flex-col gap-5">
        <ErrorAlert
          words="The stored conversation could not be read; opening the tab again retries"
          cause={held.cause}
        />
      </div>
    );
  }
  return (
    <div class="flex flex-col gap-5">
      <Totals totals={held.totals} />
      {held.note !== null && <p class="m-0 text-row muted">{held.note}</p>}
      <PromptCapture capture={capture} />
      {held.messages.length === 0 ? (
        <p class="m-0 text-row muted">
          Nothing was captured for this request's turn: the provider sent no content, or capture was off while
          it ran.
        </p>
      ) : (
        <Fragment>
          {held.next !== null && (
            <button
              type="button"
              class="btn btn-block"
              data-action="context-more"
              onClick={() => act("context-more")}
            >
              {held.loadingOlder
                ? "Loading…"
                : `Load ${Math.min(40, held.totals.messages - held.messages.length)} earlier messages`}
            </button>
          )}
          {held.messages.map((message, at) => (
            <Message key={`${message.requestId}:${message.role}:${at}`} message={message} />
          ))}
        </Fragment>
      )}
      {held.messages.length > 0 && held.next === null && (
        <p class="m-0 text-meta muted">
          The conversation begins here: everything the transcript kept for this agent.
        </p>
      )}
    </div>
  );
}
