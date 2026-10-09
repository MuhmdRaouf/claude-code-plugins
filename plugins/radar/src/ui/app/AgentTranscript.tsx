/**
 * The live agent transcript: the shared SlideOver floating over the Agents view, opened by clicking an
 * agent row — Main, a subagent or a job. The body is the agent's conversation as a daisyUI chat, oldest
 * at the top, newest at the bottom: its prompts and tool results as chat-start bubbles, its answers —
 * text, thinking, tool calls — as chat-end bubbles, each with its time. The blocks render through the
 * same renderers the request inspector uses, so folds, cut badges and images look exactly as they do
 * there. While the agent is live, a new request over the stream refetches the transcript; the view
 * follows the newest message while the reader is at the bottom, and holds still — offering a
 * "New messages" jump — when they scrolled up.
 */

import { SlideOver } from "@muhmdraouf/ui/slide-over.tsx";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { totalTokens } from "../../shared/model.ts";
import { fmtAgo, fmtBytes, fmtClock, fmtCount, fmtTokens, fmtUsd } from "../fmt.ts";
import type { ContentBlock, ContextMessage } from "../state.ts";
import { transcriptAgentOf } from "../state.ts";
import { Block } from "./Content.tsx";
import { useApp } from "./context.ts";
import { ErrorAlert } from "./inspector/ContextTab.tsx";
import { ModelChip } from "./kit.tsx";

/** A scroll position this close to the bottom still counts as reading the newest message. */
const NEAR_BOTTOM_PX = 80;

/** The slide-over, open whenever a node is picked; every close path ends in the controller's clear. */
export function AgentTranscript(): JSX.Element | null {
  const { state, act } = useApp();
  const nodeId = state.agentNode;
  if (nodeId === null) return null;
  return (
    <SlideOver
      open
      onClose={() => act("close-agent-transcript")}
      label="Agent transcript"
      header={<TranscriptHeader nodeId={nodeId} />}
    >
      <TranscriptBody nodeId={nodeId} />
    </SlideOver>
  );
}

/** The header's two lines: the agent's name, kind and state, then its requests, tokens and cost. */
function TranscriptHeader({ nodeId }: { nodeId: string }) {
  const { state, act } = useApp();
  const held = transcriptAgentOf(state, nodeId);
  if (held === null) {
    return (
      <div class="min-w-0" id="transcript-title">
        <p class="m-0 truncate text-lg font-semibold" title={nodeId}>
          {nodeId}
        </p>
        <p class="muted m-0 mt-1 text-meta">Reading this agent's details…</p>
      </div>
    );
  }
  const { sessionId, agent } = held;
  const name = agent.kind === "main" ? "Main" : (agent.description ?? agent.name ?? agent.id.slice(0, 10));
  return (
    <div class="min-w-0" id="transcript-title">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span class="truncate text-lg font-semibold" title={agent.description ?? agent.name ?? agent.id}>
          {name}
        </span>
        <span class="badge badge-ghost badge-sm">{agent.kind}</span>
        {agent.agentType !== null && (
          <span class="badge badge-ghost badge-sm font-mono">{agent.agentType}</span>
        )}
        {agent.model !== null && <ModelChip model={agent.model} />}
        {agent.live ? (
          <span class="badge badge-success badge-soft">
            <span class="status status-success neon-dot motion-safe:animate-ping" aria-hidden="true" />
            Live
          </span>
        ) : (
          <span class="badge badge-ghost">Ended</span>
        )}
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          data-action="agent-requests"
          onClick={() => act("agent-requests", JSON.stringify({ sessionId, agentId: agent.id }))}
        >
          Show its requests
        </button>
      </div>
      <p class="muted m-0 mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-meta">
        <span>{fmtCount(agent.requests, "request")}</span>
        <span>{fmtTokens(totalTokens(agent.tokens))}</span>
        <span {...(agent.costUsd != null ? { title: "Estimate at list price" } : {})}>
          {agent.costUsd != null ? `${fmtUsd(agent.costUsd)} est.` : "unpriced"}
        </span>
      </p>
    </div>
  );
}

/** The skeleton of the chat, while the server rebuilds the conversation. */
function TranscriptLoading() {
  return (
    <div class="flex flex-col gap-4" role="status">
      <span class="sr-only">Rebuilding the transcript…</span>
      {[0, 1, 2, 3].map((row) => (
        <div class="skeleton h-12" key={row} />
      ))}
    </div>
  );
}

/** One turn as a chat bubble: its prompts and results start on the left, its answers end on the right. */
function Bubble({ message }: { message: ContextMessage }) {
  const { now } = useApp();
  const mine = message.role === "assistant";
  return (
    <div class={`chat ${mine ? "chat-end" : "chat-start"}`}>
      <div class="chat-header flex items-center gap-2 text-sm">
        <span class={`badge badge-sm ${mine ? "badge-success" : "badge-info"}`}>{message.role}</span>
        <time title={new Date(message.ts).toISOString()}>{fmtClock(message.ts)}</time>
      </div>
      <div class="chat-bubble w-auto max-w-full">
        <div class="flex flex-col gap-2">
          {message.blocks.map((block, at) => (
            <Block key={at} block={block as ContentBlock} />
          ))}
        </div>
      </div>
      <div class="chat-footer flex items-center gap-2 text-sm opacity-70">
        <span>{fmtAgo(message.ts, now)}</span>
        <span class="badge badge-ghost badge-sm num">{fmtBytes(message.bytes)}</span>
      </div>
    </div>
  );
}

/**
 * The conversation itself. The scroll container is the slide-over's own body; a scroll listener keeps
 * the at-the-bottom answer, and an effect keyed on the newest message's identity does the following —
 * appended turns pin the view to the bottom, turns that arrive while the reader is above raise the
 * "New messages" button instead. Prepends (the "Load earlier" pages) change nothing.
 */
function Chat({
  messages,
  next,
  loadingOlder,
  note,
}: {
  messages: ContextMessage[];
  next: string | null;
  loadingOlder: boolean;
  note: string | null;
}) {
  const { act } = useApp();
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const atBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);

  useEffect(() => {
    const el = root.current?.closest<HTMLElement>("[data-slide-over-body]") ?? null;
    scroller.current = el;
    const onScroll = () => {
      if (el === null) return;
      const near = el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX;
      atBottom.current = near;
      if (near) setUnseen(false);
    };
    el?.addEventListener("scroll", onScroll);
    return () => el?.removeEventListener("scroll", onScroll);
  }, []);

  const newest = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const newestKey = newest === undefined ? "" : `${newest.ts}:${newest.requestId}`;
  const previous = useRef("");
  useEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    if (newestKey !== previous.current && previous.current !== "" && !atBottom.current) {
      setUnseen(true); // a turn landed above the reader's view; the button offers the jump
    }
    previous.current = newestKey;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [newestKey]);

  const jump = (): void => {
    const el = scroller.current;
    atBottom.current = true;
    setUnseen(false);
    if (el !== null) el.scrollTop = el.scrollHeight;
  };

  return (
    <div ref={root} class="flex flex-col gap-4">
      {note !== null && <p class="m-0 text-meta muted">{note}</p>}
      {next !== null && (
        <button
          type="button"
          class="btn btn-block"
          data-action="agent-transcript-more"
          onClick={() => act("agent-transcript-more")}
        >
          {loadingOlder ? "Loading…" : "Load earlier messages"}
        </button>
      )}
      {messages.map((message, at) => (
        <Bubble key={`${message.requestId}:${message.role}:${at}`} message={message} />
      ))}
      {unseen && (
        <div class="pointer-events-none sticky bottom-4 z-10 flex justify-center">
          <button type="button" class="btn btn-primary btn-sm pointer-events-auto" onClick={jump}>
            New messages
          </button>
        </div>
      )}
    </div>
  );
}

/** The body's states, then the chat. */
function TranscriptBody({ nodeId }: { nodeId: string }) {
  const { state, act } = useApp();
  const held = state.agentTranscript;
  if (held === null || held.status === "loading") return <TranscriptLoading />;
  if (held.status === "missing") {
    return (
      <p class="m-0 text-row muted">
        Not in the history store: the agent ran before history was on, or its store was pruned.
      </p>
    );
  }
  if (held.status === "off") {
    return <p class="m-0 text-row muted">History is off, so this transcript cannot be shown.</p>;
  }
  if (held.status === "error") {
    return (
      <div class="flex flex-col gap-3">
        <ErrorAlert words="The stored transcript could not be read" cause={held.cause} />
        <div>
          <button
            type="button"
            class="btn btn-sm"
            data-action="agent-transcript"
            onClick={() => act("agent-transcript", nodeId)}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (held.messages.length === 0) {
    return (
      <p class="m-0 text-row muted">
        Nothing stored for this agent yet: a turn appears once its first request has been captured.
      </p>
    );
  }
  return <Chat messages={held.messages} next={held.next} loadingOlder={held.loadingOlder} note={held.note} />;
}
