// dialog.tsx — a modal <dialog>: focus stays inside while it is open, Escape and a scrim click close it,
// and focus returns to the element that opened it — unless another dialog took over (a drawer that closes
// because another one opened keeps the focus in the new one). Port of core.js openDlg/closeDlg plus the
// per-dialog wiring, and of app.js openModal's title + close-button shell.

import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

/** What a dialog shows: whether it is open, how to close it, an optional title and the body. */
export type DialogProps = {
  open: boolean;
  onClose: () => void;
  title?: ComponentChildren | undefined;
  /** The dialog's class; the modal default styles the #modal shell, pass "drawer hr-dialog" for a drawer */
  class?: string | undefined;
  labeledBy?: string | undefined;
  children: ComponentChildren;
};

/** The close icon the legacy modal button carries. */
const X = (
  <svg
    class="size-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

/**
 * A modal dialog on the native <dialog> element. Rendering with `open` shows it modally; every close path —
 * Escape, the scrim, the header button, the parent flipping `open` — ends in one `onClose` call and, when no
 * other dialog is open, focus back on the element that had it before.
 */
export function Dialog({
  open,
  onClose,
  title,
  class: c = "dlg hr-dialog",
  labeledBy,
  children,
}: DialogProps): JSX.Element {
  const dlg = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);

  // Open modally and remember what to give focus back to; close when the parent flips `open` off.
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // The native close event is the one path every close ends in: tell the parent, give focus back.
  const closed = (): void => {
    onClose();
    const t = opener.current;
    opener.current = null;
    const back =
      t instanceof HTMLElement &&
      t.isConnected &&
      !t.closest("dialog:not([open])") &&
      !document.querySelector("dialog[open]")
        ? t
        : null;
    back?.focus({ preventScroll: true });
  };

  return (
    <dialog
      ref={dlg}
      // Preact binds `onClose` to the element's native close event
      onClose={closed}
      class={c}
      aria-labelledby={labeledBy ?? (title ? "mtitle" : undefined)}
      onClick={(e) => {
        // a click that reached the dialog itself hit the scrim around the box
        if (e.target === dlg.current) closeNow(dlg.current);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeNow(dlg.current);
        }
      }}
    >
      {title ? (
        <div class="dlg-h">
          <h2 id="mtitle" class="min-w-0 flex-1 truncate font-semibold">
            {title}
          </h2>
          <button
            type="button"
            class="btn btn-ghost btn-icon"
            aria-label="Close"
            onClick={() => closeNow(dlg.current)}
          >
            {X}
          </button>
        </div>
      ) : null}
      <div class="min-h-0 overflow-y-auto">{children}</div>
    </dialog>
  );
}

/** Close the dialog once, through the native close so the refocus and `onClose` run exactly once. */
function closeNow(d: HTMLDialogElement | null): void {
  if (d?.open) d.close();
}
