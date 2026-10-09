// ComposeDialog.tsx — openCompose: the composer in the shared modal dialog, titled for what it will
// do ("Send a message", "Ask a question", "New task", "Reply to X"). Port of compose.js
// openCompose; the dialog itself — one modal, Escape and the scrim close it, focus back on the
// trigger — is the shared Dialog, and opening lands the focus on the title field of a task or on
// the message box, the way openCompose's last line did.

import { Dialog } from "@muhmdraouf/ui/dialog.tsx";
import type { ToastFn } from "@muhmdraouf/ui/toast.tsx";
import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { Api } from "../api.ts";
import type { Storage } from "../storage.ts";
import type { Board, FeedEvent, PlanStep, RosterSession, Timers } from "../store.ts";
import { Composer, type ComposeSent, composeTitle } from "./Composer.tsx";
import {
  browserTimers,
  type ComposeOptions,
  createDrafts,
  type Draft,
  type Drafts,
  localDraftStorage,
} from "./drafts.ts";

/** What ComposeDialog shows: whether it is open, how to close it, the composer's host data and the
 *  openCompose options that shape the draft. */
export type ComposeDialogProps = {
  /** Whether the dialog is on screen; the app owns the flag. */
  open: boolean;
  /** Closes the dialog: Escape, the scrim, the header button, the Cancel button, a sent message. */
  onClose: () => void;
  /** openCompose's options, applied to the dialog's draft whenever they change. */
  options?: ComposeOptions | undefined;
  /** The channel to compose in; without one there is nothing to compose into. */
  ch: string;
  /** The roster the To menu offers. */
  sessions: readonly RosterSession[];
  /** The plan the task pickers rank. */
  board: Board | null;
  /** Looks a plan task up by id, for the pickers' chips. */
  byId: (id: string) => PlanStep | null | undefined;
  /** The API client the sends go through. */
  api: Api;
  /** Called once a send succeeded (see ComposeSent). */
  onSent: ComposeSent;
  /** The toast stack the composer reports through. */
  toast: ToastFn;
  /** The timeline, to find the event a reply answers. */
  timeline?: readonly FeedEvent[] | null | undefined;
  /** Where the dialog's drafts persist; the page's localStorage when omitted. */
  storage?: Storage | undefined;
  /** The save timer; the browser's when omitted. */
  timers?: Timers | undefined;
  /** The current time, for a replied-to event's relative stamp; Date.now() when omitted. */
  now?: number | undefined;
};

/** The dialog draft's place, the way openCompose always mounted it. */
const PLACE = "dlg";

/** The mode and reply of a draft — the two fields the dialog's title reads. */
type TitleMeta = { mode: Draft["mode"]; reply: number | null };

/** The meta a draft means for the title. */
const metaOf = (d: Draft): TitleMeta => ({ mode: d.mode, reply: d.reply });

/** openCompose: the composer in a modal dialog, titled for what it will do; nothing without a channel. */
export function ComposeDialog(props: ComposeDialogProps): JSX.Element | null {
  const { ch, open, onClose, options, timeline } = props;

  const drafts: Drafts = useMemo(
    () => createDrafts(props.storage ?? localDraftStorage(), props.timers ?? browserTimers),
    [props.storage, props.timers],
  );

  // the title follows the draft: the composer tells it after every repaint it makes
  const [meta, setMeta] = useState<TitleMeta>(() => metaOf(drafts.draft(ch, PLACE)));
  const onDraft = useCallback((d: Draft) => {
    setMeta((m) => (m.mode === d.mode && m.reply === d.reply ? m : metaOf(d)));
  }, []);

  // a pending save outlives the dialog only if it is written now
  useEffect(() => () => drafts.flush(), [drafts]);

  // openCompose's focus: a task with no reply starts in its title, everything else in the message
  useEffect(() => {
    if (!open) return;
    const d = drafts.draft(ch, PLACE);
    const el =
      d.reply == null && d.mode === "task"
        ? document.getElementById("dlg-title")
        : document.getElementById("dlg-msg");
    el?.focus();
  }, [open, drafts, ch]);

  // openCompose: no channel, nothing to compose into (every hook above stays mounted)
  if (!ch) return null;

  const rep = meta.reply != null ? (timeline?.find((x) => x.seq === meta.reply) ?? null) : null;

  return (
    <Dialog open={open} onClose={onClose} title={composeTitle(meta.mode, rep)}>
      <Composer
        ch={ch}
        place={PLACE}
        drafts={drafts}
        initial={options}
        dialog
        onCancel={onClose}
        onDraft={onDraft}
        timeline={timeline}
        now={props.now}
        sessions={props.sessions}
        board={props.board}
        byId={props.byId}
        api={props.api}
        onSent={props.onSent}
        toast={props.toast}
      />
    </Dialog>
  );
}
