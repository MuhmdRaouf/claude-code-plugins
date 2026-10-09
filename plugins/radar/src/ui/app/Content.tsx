/**
 * The stored sides of a request, rendered once their tabs open: every block is a daisyUI collapse — a
 * title row of kind, size and first line, opening into prose for text and a code mockup for code and
 * JSON. Each block carries a copy button and long ones fold behind a "Show all" until pressed.
 */

import { Markdown } from "@muhmdraouf/ui/markdown.tsx";
import { type ComponentChildren, Fragment } from "preact";
import { useState } from "preact/hooks";
import { fmtBytes } from "../fmt.ts";
import { blockBytes, blocksOf, blockText, type ContentBlock, resultBlocks } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { firstLine } from "./inspector/util.ts";
import { Code } from "./kit.tsx";

/** A block this large folds to a first look at itself until "Show all" says otherwise. */
const FOLD_BYTES = 8 * 1024;
/** How much of a folded block stays visible. */
const FOLD_SHOWN = 2 * 1024;

/** Copy a block's text to the clipboard when the browser allows it; a copied button says so for a moment. */
export function CopyButton({
  text,
  label = "Copy this block",
  class: cls = "block-copy btn btn-ghost btn-square btn-sm",
  children = null,
}: {
  text: string;
  label?: string;
  class?: string;
  /** visible words, for a labelled button (the Raw tab's "Copy as JSON") */
  children?: ComponentChildren;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class={cls}
      aria-label={label}
      title={label}
      onClick={(event) => {
        // a copy inside a collapse's title row must not fold or unfold the block
        event.preventDefault();
        event.stopPropagation();
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {children ?? <Icon name={copied ? "check" : "copy"} class="size-4.5" />}
    </button>
  );
}

/** One block's collapsed shell: the title row, then the content the fold opens into. */
function BlockCollapse({
  head,
  class: cls = "collapse collapse-arrow panel",
  children,
}: {
  head: ComponentChildren;
  class?: string | undefined;
  children: ComponentChildren;
}) {
  return (
    <details class={cls}>
      <summary class="collapse-title">
        <span class="flex min-w-0 items-center gap-2">{head}</span>
      </summary>
      <div class="collapse-content flex flex-col gap-2">{children}</div>
    </details>
  );
}

/** A kind's word at the head of a row: the smallest label that still names the block. */
function KindLabel({ text }: { text: string }) {
  return <span class="shrink-0 text-sm font-medium">{text}</span>;
}

/** A block's byte size as a quiet badge; fixed so a long preview can never push it out. */
function SizeBadge({ bytes }: { bytes: number }) {
  return <span class="badge badge-ghost badge-sm num shrink-0">{fmtBytes(bytes)}</span>;
}

/** Says a block's text was cut at ingest, with the size the original had. */
function CutBadge({ block }: { block: ContentBlock }) {
  if (block.truncated === undefined || block.truncated <= 0) return null;
  const original = blockBytes(block) + block.truncated;
  return (
    <span
      class="badge badge-soft badge-warning badge-sm shrink-0"
      title={`Truncated at ingest; the original text was ${fmtBytes(original)}`}
    >
      cut from {fmtBytes(original)}
    </span>
  );
}

/** A block's first line as the row's scan anchor; it truncates so the badges keep their place. */
function Preview({ text }: { text: string }) {
  return <span class="min-w-0 flex-1 truncate text-row muted">{text === "" ? "(no text)" : text}</span>;
}

/** Code or JSON as a daisyUI code mockup; long lines wrap instead of scrolling out of the panel. */
function CodeMock({ text }: { text: string }) {
  return (
    <div class="mockup-code">
      <pre class="whitespace-pre-wrap wrap-anywhere">
        <code>{text}</code>
      </pre>
    </div>
  );
}

/** A block's text, cut to the fold when it is a long one, with the button that unfolds it: prose for
 *  text, a code mockup for everything else. */
function BlockBody({ block, plain = false }: { block: ContentBlock; plain?: boolean }) {
  const [open, setOpen] = useState(false);
  const text = blockText(block);
  const bytes = blockBytes(block);
  const long = bytes > FOLD_BYTES && !open;
  const shown = long ? `${text.slice(0, FOLD_SHOWN)}…` : text;
  return (
    <>
      {plain ? (
        <CodeMock text={shown} />
      ) : (
        <div class="max-w-[80ch] text-[0.9375rem] leading-relaxed">
          <Markdown text={shown} />
        </div>
      )}
      {long && (
        <button
          type="button"
          class="block-fold-btn btn btn-ghost btn-sm self-start"
          onClick={() => setOpen(true)}
        >
          Show all ({fmtBytes(bytes)})
        </button>
      )}
    </>
  );
}

/** A text (or unknown-shape) block: its kind, size and first line, opening into the words themselves. */
function TextBlock({ block }: { block: ContentBlock }) {
  const text = blockText(block);
  return (
    <BlockCollapse
      head={
        <>
          <KindLabel text={block.type === "text" ? "Text" : block.type || "Block"} />
          <SizeBadge bytes={blockBytes(block)} />
          <CutBadge block={block} />
          <Preview text={firstLine(text)} />
          <CopyButton text={text} />
        </>
      }
    >
      <BlockBody block={block} plain={block.type !== "text"} />
    </BlockCollapse>
  );
}

/** A thinking block: the same folded row, opened into the model's words as a code mockup. */
function ThinkingBlock({ block }: { block: ContentBlock }) {
  const text = blockText(block);
  return (
    <BlockCollapse
      class="block-think collapse collapse-arrow panel"
      head={
        <>
          <KindLabel text="Thinking" />
          <SizeBadge bytes={blockBytes(block)} />
          <CutBadge block={block} />
          <Preview text={firstLine(text)} />
        </>
      }
    >
      <BlockBody block={block} plain />
    </BlockCollapse>
  );
}

/** A media block (an image, a document) as a labelled item: its kind, media type and size — the
 *  ingest kept a marker for it, never the data itself. */
function MediaBlock({ block }: { block: ContentBlock }) {
  const kind = block.type === "" ? "Media" : `${block.type[0]?.toUpperCase() ?? ""}${block.type.slice(1)}`;
  const label = [kind, block.media_type, typeof block.bytes === "number" ? fmtBytes(block.bytes) : null]
    .filter((part) => part !== null)
    .join(", ");
  const marker = blockText(block);
  return (
    <BlockCollapse
      class="block-media collapse collapse-arrow panel"
      head={
        <>
          <KindLabel text={label} />
          <Preview text={firstLine(marker)} />
        </>
      }
    >
      <CodeMock text={marker} />
    </BlockCollapse>
  );
}

/** A tool call: its name as the row's anchor, opening into its input as readable JSON. */
function ToolUseBlock({ block }: { block: ContentBlock }) {
  const json = JSON.stringify(block.input ?? null, null, 2);
  return (
    <BlockCollapse
      head={
        <>
          <KindLabel text="Tool call" />
          <span class="min-w-0 flex-1 truncate">
            <Code text={block.name ?? "unknown"} />
          </span>
          <CopyButton text={json} />
        </>
      }
    >
      <CodeMock text={json} />
    </BlockCollapse>
  );
}

/** A tool result: the call it answers, an error badge when it failed, and its own blocks. */
function ToolResultBlock({ block }: { block: ContentBlock }) {
  const inner = resultBlocks(block);
  return (
    <BlockCollapse
      class={block.is_error === true ? "collapse collapse-arrow panel ring-1 ring-error/40" : undefined}
      head={
        <>
          <KindLabel text="Tool result" />
          <span class="min-w-0 flex-1 truncate">
            {block.tool_use_id !== undefined && <Code text={block.tool_use_id} class="muted" />}
          </span>
          {block.is_error === true && <span class="badge badge-soft badge-error shrink-0">Error</span>}
        </>
      }
    >
      {inner === null ? (
        <p class="m-0 text-row muted">Empty result.</p>
      ) : (
        inner.map((one, i) => <Block key={i} block={one} />)
      )}
    </BlockCollapse>
  );
}

/** One stored block, shaped by its type; an unknown shape still shows as JSON, never as nothing. */
export function Block({ block }: { block: ContentBlock }) {
  if (block.type === "tool_use") return <ToolUseBlock block={block} />;
  if (block.type === "tool_result") return <ToolResultBlock block={block} />;
  if (block.type === "thinking") return <ThinkingBlock block={block} />;
  if (block.media_type !== undefined || block.bytes !== undefined) return <MediaBlock block={block} />;
  return <TextBlock block={block} />;
}

/** One stored side: its blocks in order, or the words that say why there is nothing. */
export function Blocks({ side }: { side: unknown }) {
  const blocks = blocksOf(side);
  if (blocks === null) return <p class="m-0 text-row muted">Nothing recorded on this side.</p>;
  return (
    <Fragment>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </Fragment>
  );
}
