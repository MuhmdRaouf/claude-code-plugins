/**
 * What every component reads: the client state, the clock it renders against, the address shown in the top
 * bar, and `act`, the one way a component changes anything. Actions are the same names main.tsx has always
 * handled (`tab`, `drawer`, `sort-requests`, …), so the controller stays the single owner of state.
 */

import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { ClientState } from "../state.ts";

export type Act = (action: string, value?: string) => void;

export type AppValue = {
  state: ClientState;
  /** the render clock, ticking once a second */
  now: number;
  /** host:port the dashboard was opened on */
  url: string;
  act: Act;
};

export const AppContext = createContext<AppValue | null>(null);

/** The app value; throws outside <AppContext.Provider> so a missing provider fails loudly in tests. */
export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (value === null) throw new Error("radar: useApp() outside <AppContext.Provider>");
  return value;
}
