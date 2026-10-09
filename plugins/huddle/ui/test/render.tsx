// render.tsx — render a page inside the huddle context: `state` overrides the initial client state,
// `now` fixes the render clock, and `go`, `act`, `toast` and `copy` come back as spies the test
// asserts on. `fetchFn` answers the API; the default answers `{}` for everything.
import { render } from "@testing-library/preact";
import type { ComponentChildren } from "preact";
import { vi } from "vitest";
import { createApi, type FetchFn } from "../src/api.ts";
import { HuddleContext, type HuddleContextValue } from "../src/app/context.tsx";
import type { HuddleState } from "../src/store.ts";

/** The store state of a freshly opened, empty channel; tests override the slices they need. */
export function initialHuddleState(): HuddleState {
  return {
    ch: null,
    info: null,
    board: null,
    byId: new Map(),
    sessions: null,
    timeline: null,
    attention: null,
    channels: null,
    replies: new Map(),
    extras: null,
    live: "connecting",
  };
}

/** Renders `ui` inside <HuddleContext.Provider>: a fake api over `fetchFn`, spies for the rest. */
export function renderHuddle(
  ui: ComponentChildren,
  state: Partial<HuddleState> = {},
  now = 1_790_000_000_000,
  fetchFn: FetchFn = () =>
    Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } })),
) {
  const api = createApi(fetchFn, () => {});
  const go = vi.fn<(href: string) => void>();
  const act = vi.fn<HuddleContextValue["act"]>();
  const toast = vi.fn<HuddleContextValue["toast"]>();
  const copy = vi.fn<HuddleContextValue["copy"]>();
  const value: HuddleContextValue = {
    state: { ...initialHuddleState(), ...state },
    api,
    now,
    go,
    act,
    toast,
    copy,
  };
  const result = render(<HuddleContext.Provider value={value}>{ui}</HuddleContext.Provider>);
  return { ...result, api, go, act, toast, copy, value };
}
