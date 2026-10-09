// intro.tsx — the hand a page gets for its page-wide controls: inside the shell (App) they land
// in the PageIntro's actions slot the shell paints above every destination; a page rendered on
// its own — the page tests — shows them as a plain toolbar row above its content instead. The
// shell hands the take callback down through IntroCtx, tagged with the destination, so a stale
// registration can never surface under the wrong page.

import { type ComponentChildren, createContext, type JSX } from "preact";
import { useContext, useEffect, useRef } from "preact/hooks";

/** The context the shell fills with its take callback; a bare render finds none. */
export const IntroCtx = createContext<{ take: ((render: () => ComponentChildren) => void) | null }>({
  take: null,
});

/** A page's page-wide controls (a filter segment, a New button, an export): rendered into the
 *  shell's PageIntro actions when the shell hosts the page, or in place when it does not. */
export function IntroActions({ children }: { children: ComponentChildren }): JSX.Element | null {
  const take = useContext(IntroCtx).take;
  const slot = useRef(children);
  slot.current = children;
  const hosted = take !== null;
  useEffect(() => {
    if (hosted) take(() => slot.current);
  }, [hosted, take]);
  if (!hosted) return <div class="mb-1 flex flex-wrap items-center gap-3">{children}</div>;
  return null;
}
