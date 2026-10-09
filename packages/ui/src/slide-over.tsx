// slide-over.tsx — a large panel that slides in from the right over the whole dashboard (daisyUI modal-end on a
// native <dialog>): Escape, a click on the dimmed page or the close button closes it, focus stays inside while it
// is open and returns to whatever opened it. The header is sticky glass, the body scrolls on its own.

import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

/** What a slide-over shows: open or not, how to close it, a header and the body. */
export type SlideOverProps = {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the dialog. */
  label: string;
  /** The header's left side: title, chips, key facts. */
  header: ComponentChildren;
  /** Buttons before the close button (previous/next, copy...). */
  actions?: ComponentChildren;
  /** Under the header, above the scrolling body: the panel's tabs. */
  tabs?: ComponentChildren;
  /** Width; defaults to most of a wide screen and all of a narrow one. */
  width?: string;
  /** The dialog element's id, for the code that recognizes one slide-over by it. */
  id?: string;
  children: ComponentChildren;
};

const X = (
  <svg
    class="size-5"
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

/** The right-hand slide-over. Every close path (Escape, backdrop, button, `open` turning false) ends in one onClose. */
export function SlideOver({
  open,
  onClose,
  label,
  header,
  actions,
  tabs,
  width = "w-[min(64rem,94vw)]",
  id,
  children,
}: SlideOverProps): JSX.Element {
  const dlg = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);

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

  const closed = (): void => {
    onClose();
    const back = opener.current;
    opener.current = null;
    if (back instanceof HTMLElement && back.isConnected && !document.querySelector("dialog[open]")) {
      back.focus({ preventScroll: true });
    }
  };
  const close = (): void => {
    if (dlg.current?.open) dlg.current.close();
  };

  return (
    <dialog
      ref={dlg}
      id={id}
      class="modal modal-end"
      aria-label={label}
      // Preact binds onClose to the native close event, the one path every close ends in
      onClose={closed}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div
        class={`modal-box flex h-dvh max-h-none ${width} max-w-none flex-col rounded-none rounded-l-box p-0 neon-ring`}
        data-slide-over
      >
        <div class="glass sticky top-0 z-10 border-b border-base-content/8">
          <div class="flex items-start gap-4 px-6 pt-5 pb-4">
            <div class="min-w-0 flex-1">{header}</div>
            <div class="flex shrink-0 items-center gap-1">
              {actions}
              <button
                type="button"
                class="btn btn-ghost btn-square"
                aria-label="Close"
                title="Close (Esc)"
                onClick={close}
              >
                {X}
              </button>
            </div>
          </div>
          {tabs ? <div class="px-6 pb-3">{tabs}</div> : null}
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-slide-over-body>
          {children}
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button type="submit" aria-label="Close">
          close
        </button>
      </form>
    </dialog>
  );
}
