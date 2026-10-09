/**
 * The browser entry: build the controller on the browser's own objects, render <App/> on every state change and
 * once a second (relative times and the live chart move with the clock), and own the few listeners that live
 * outside the component tree: the URL hash, the system theme, Escape and R.
 */

import { render } from "preact";
import { App } from "./app/App.tsx";
import "./app.css";
import { AppContext } from "./app/context.ts";
import { type EventStream, type Io, RadarController } from "./app/controller.ts";
import type { ThemePref } from "./state.ts";

const queried = document.querySelector<HTMLElement>("#root");
if (queried === null) throw new Error("radar: #root missing");
// annotated non-null so the closures below capture a stable HTMLElement, not the nullable query result
const root: HTMLElement = queried;
root.classList.remove("boot"); // the static "starting" splash centres itself; the dashboard does not
root.replaceChildren();
const url = location.host === "" ? "127.0.0.1" : location.host;

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Resolve the choice to a palette on <html>; "system" follows prefers-color-scheme. The palettes are the
 * shared package's daisyUI themes: mocha is the dark one, latte the light one. */
function applyTheme(pref: ThemePref): void {
  const dark = pref === "dark" || (pref === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "mocha" : "latte";
}

/** On a narrow screen the view can sit far down the page; bring its top into sight after a tab change,
 *  clearing the sticky scope header the main pane scrolls under. */
function revealView(): void {
  const view = root.querySelector<HTMLElement>("[data-view]");
  if (view === null || view.getBoundingClientRect().top < window.innerHeight * 0.6) return;
  const header = root.querySelector<HTMLElement>("[data-scope-header]")?.offsetHeight ?? 0;
  window.scrollTo({
    top: window.scrollY + view.getBoundingClientRect().top - header - 12,
    behavior: reducedMotion.matches ? "auto" : "smooth",
  });
}

/** Hand the reader a CSV file: an object URL on a throwaway link, revoked once the click has been taken. */
function download(name: string, text: string): void {
  const href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function focusOpener(id: string): void {
  for (const row of root.querySelectorAll<HTMLElement>('[data-action="drawer"]')) {
    if (row.getAttribute("data-value") === id) {
      row.focus();
      return;
    }
  }
}

/** The browser's EventSource behind the controller's slice of it, forwarding the three handlers it sets. */
class BrowserStream implements EventStream {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  private readonly source: EventSource;

  constructor(path: string) {
    this.source = new EventSource(path);
    this.source.onopen = () => this.onopen?.();
    this.source.onerror = () => this.onerror?.();
    this.source.onmessage = (message) => this.onmessage?.(message);
  }

  close(): void {
    this.source.close();
  }
}

const io: Io = {
  fetch: (path, init) => fetch(path, init),
  EventSource: BrowserStream,
  storage: localStorage,
  location,
  replaceHash: (hash) => history.replaceState(null, "", hash),
  // the rail's panel, search, repo and scope get a real history entry, so Back returns to them
  pushHash: (hash) => {
    location.hash = hash;
  },
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  download,
  href: () => location.href,
  clipboard: (text) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  },
  applyTheme,
  revealView,
  focusOpener,
};

const controller = new RadarController(io);
const act = (action: string, value = ""): void => controller.act(action, value);

function paint(): void {
  render(
    <AppContext.Provider value={{ state: controller.getState(), now: Date.now(), url, act }}>
      <App />
    </AppContext.Provider>,
    root,
  );
}

controller.subscribe(paint);
setInterval(paint, 1000);

window.addEventListener("hashchange", () => act("hash", location.hash));
darkQuery.addEventListener("change", () => {
  if (controller.getState().theme === "system") applyTheme("system");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    act("close-drawer");
    return;
  }
  const typing = event.target instanceof HTMLElement && event.target.matches("input, textarea, select");
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "j" || event.key === "J") {
    act("next-request");
    return;
  }
  if (event.key === "k" || event.key === "K") {
    act("prev-request");
    return;
  }
  if (event.key === "r" || event.key === "R") act("refresh");
});

paint();
controller.start();
