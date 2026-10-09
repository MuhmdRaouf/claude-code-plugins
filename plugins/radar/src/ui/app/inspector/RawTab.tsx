/**
 * The inspector's Raw tab: the stored request record and its content as pretty JSON in a code mockup,
 * with one "Copy as JSON" for the whole request — the research's answer to copying forty attributes one
 * by one.
 */

import type { RequestRecord } from "../../../shared/model.ts";
import { CopyButton } from "../Content.tsx";
import { useApp } from "../context.ts";
import { prettyJson, rawDocument } from "./util.ts";

/** The raw record and content in a code mockup, with the whole-request copy button. */
export function RawTab({ request }: { request: RequestRecord }) {
  const { state } = useApp();
  const held = state.content[request.id];
  const content = held?.status === "ready" ? { input: held.input, output: held.output } : null;
  const text = prettyJson(rawDocument(request, content));
  return (
    <div class="flex flex-col gap-3">
      <div class="raw-actions flex items-center gap-2.5">
        <CopyButton text={text} label="Copy raw JSON" class="btn btn-ghost btn-square btn-sm" />
        <span class="raw-hint text-meta muted">
          {held === undefined || held.status === "loading"
            ? "The stored sides load with the Input or Output tab; showing the record alone."
            : held.status === "ready"
              ? "The request record and both stored sides."
              : "The request record; the stored sides are unavailable."}
        </span>
      </div>
      <div class="raw-code mockup-code max-h-[70vh] overflow-auto">
        <pre class="whitespace-pre-wrap wrap-anywhere">
          <code>{text}</code>
        </pre>
      </div>
    </div>
  );
}
