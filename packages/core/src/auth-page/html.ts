// The one page: inline HTML, one nonce'd style block and one nonce'd script (the show/hide toggle and the busy
// button; the form works without it). No external scripts, styles, fonts or images; the only URLs are the provider's
// own pages, as links. The look is the Huddle and Radar sign-in card: Catppuccin Latte, Mocha by the system's
// colour scheme, the same tokens, radius and focus ring.

interface PageBase {
  /** The plugin, as the version line names it: "zai-plugin-cc". */
  readonly plugin: string;
  readonly version?: string;
  readonly display: string;
  readonly storeLabel: string;
  /** The provider's API-key page, linked from step 1. */
  readonly keysUrl: string;
  readonly billingUrl: string;
}

/** form: the three steps, with the last try's error if any. saved: the key is stored (limited: the provider knows it
 *  but will not serve it yet). ended: no more tries on this page. */
type PageState =
  | { readonly kind: "form"; readonly csrf: string; readonly error?: string }
  | { readonly kind: "saved"; readonly limited: boolean }
  | { readonly kind: "ended"; readonly text: string };

export type PageView = PageBase & { readonly state: PageState };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
:root {
  --ctp-red: #d20f39; --ctp-green: #40a02b; --ctp-blue: #1e66f5; --ctp-peach: #fe640b;
  --ctp-text: #4c4f69; --ctp-subtext1: #5c5f77; --ctp-subtext0: #6c6f85; --ctp-overlay2: #7c7f93;
  --ctp-surface1: #bcc0cc; --ctp-surface0: #ccd0da;
  --ctp-base: #eff1f5; --ctp-mantle: #e6e9ef; --ctp-crust: #dce0e8;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ctp-red: #f38ba8; --ctp-green: #a6e3a1; --ctp-blue: #89b4fa; --ctp-peach: #fab387;
    --ctp-text: #cdd6f4; --ctp-subtext1: #bac2de; --ctp-subtext0: #a6adc8; --ctp-overlay2: #9399b2;
    --ctp-surface1: #45475a; --ctp-surface0: #313244;
    --ctp-base: #1e1e2e; --ctp-mantle: #181825; --ctp-crust: #11111b;
    color-scheme: dark;
  }
}
:root {
  --bg: var(--ctp-mantle); --panel: var(--ctp-base);
  --border: var(--ctp-surface0); --border-2: var(--ctp-surface1);
  --text: var(--ctp-text); --muted: var(--ctp-subtext1);
  --faint: color-mix(in srgb, var(--ctp-subtext0) 60%, var(--ctp-text));
  --primary: var(--ctp-blue); --primary-bg: color-mix(in srgb, var(--ctp-blue) 85%, var(--ctp-text));
  --on-primary: var(--ctp-base);
  --blue-ink: color-mix(in srgb, var(--ctp-blue) 65%, var(--ctp-text));
  --green-ink: color-mix(in srgb, var(--ctp-green) 35%, var(--ctp-text));
  --red-ink: color-mix(in srgb, var(--ctp-red) 80%, var(--ctp-text));
  --peach-ink: color-mix(in srgb, var(--ctp-peach) 35%, var(--ctp-text));
  --shadow-sm: 0 1px 2px rgb(76 79 105 / .06);
  --radius: 10px;
  --font-sans: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --muted: var(--ctp-subtext0); --faint: var(--ctp-overlay2);
    --primary-bg: var(--ctp-blue); --on-primary: var(--ctp-crust);
    --blue-ink: var(--ctp-blue); --green-ink: var(--ctp-green); --red-ink: var(--ctp-red); --peach-ink: var(--ctp-peach);
    --shadow-sm: 0 1px 2px rgb(0 0 0 / .3);
  }
}
*, *::before, *::after { box-sizing: border-box; }
html, body { min-height: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 var(--font-sans); font-feature-settings: "cv11", "ss01";
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
}
:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 6px; }
::selection { background: color-mix(in srgb, var(--primary) 28%, transparent); }
h1, h2, p, ol { margin: 0; }
a { color: var(--blue-ink); text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
svg { flex: none; }
.signin { display: grid; min-height: 100dvh; place-items: center; padding: 16px; }
.stack { display: flex; width: 100%; max-width: 28rem; flex-direction: column; gap: 32px; }
.head { display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; }
.logo {
  display: inline-flex; width: 64px; height: 64px; align-items: center; justify-content: center;
  border-radius: 16px; color: var(--blue-ink);
  background: color-mix(in srgb, var(--primary) 14%, var(--panel));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 30%, transparent);
}
.logo.ok {
  color: var(--green-ink);
  background: color-mix(in srgb, var(--ctp-green) 14%, var(--panel));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ctp-green) 30%, transparent);
}
h1 { font-size: 30px; line-height: 36px; font-weight: 700; letter-spacing: -0.025em; }
.lead { font-size: 15px; color: var(--muted); }
.card {
  display: flex; flex-direction: column; gap: 20px; padding: 24px;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-sm);
}
.steps { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 20px; counter-reset: step; }
.steps > li { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 12px; counter-increment: step; }
.steps > li::before {
  content: counter(step); display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center;
  border-radius: 999px; border: 1px solid var(--border-2); background: var(--bg);
  font-size: 12px; font-weight: 600; color: var(--muted); font-variant-numeric: tabular-nums;
}
.step { display: flex; min-width: 0; flex-direction: column; gap: 8px; padding-top: 1px; }
.step-title { font-weight: 500; }
.field {
  display: flex; height: 40px; align-items: center; gap: 4px; padding-right: 4px;
  border: 1px solid var(--border-2); border-radius: 8px; background: var(--bg);
  transition: border-color .15s, box-shadow .15s;
}
.field:hover { border-color: var(--faint); }
.field:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 25%, transparent); }
.field.invalid { border-color: var(--red-ink); }
.field input {
  min-width: 0; flex: 1; height: 100%; padding: 0 10px; border: 0; background: transparent; color: var(--text);
  font: 13.5px var(--font-mono); letter-spacing: -0.01em;
}
.field input:focus-visible { outline: none; }
.reveal {
  display: inline-flex; height: 30px; align-items: center; gap: 6px; padding: 0 8px;
  border: 0; border-radius: 6px; background: transparent; color: var(--muted); font: 500 12.5px var(--font-sans); cursor: pointer;
}
.reveal:hover { color: var(--text); background: color-mix(in srgb, var(--border) 55%, transparent); }
.reveal[hidden] { display: none; }
.btn {
  display: inline-flex; width: 100%; height: 40px; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid transparent; border-radius: 8px; background: var(--primary-bg); color: var(--on-primary);
  font: 500 14px var(--font-sans); cursor: pointer;
}
.btn:hover { filter: brightness(1.1); }
.btn:active { filter: brightness(.95); }
.btn[aria-disabled="true"] { cursor: progress; filter: saturate(.6); }
.note {
  display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px solid; border-radius: 8px; font-size: 13px;
}
.note svg { margin-top: 1px; }
.note.bad { color: var(--red-ink); border-color: color-mix(in srgb, var(--ctp-red) 30%, var(--panel)); background: color-mix(in srgb, var(--ctp-red) 9%, var(--panel)); }
.note.warn { color: var(--peach-ink); border-color: color-mix(in srgb, var(--ctp-peach) 30%, var(--panel)); background: color-mix(in srgb, var(--ctp-peach) 9%, var(--panel)); }
.note p { color: var(--text); }
.note a { color: inherit; }
.done { display: flex; flex-direction: column; gap: 6px; }
.done h2 { font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
.done p, .muted { color: var(--muted); }
.foot { display: flex; flex-direction: column; gap: 4px; text-align: center; font-size: 12px; color: var(--faint); }
@media (max-width: 480px) {
  .card { padding: 20px; }
  h1 { font-size: 26px; line-height: 32px; }
}
@media (prefers-reduced-motion: reduce) { .field { transition: none; } }
`;

// Show/hide for the key, and a busy button once the form is sent. The toggle stays hidden without JS.
const SCRIPT = `(() => {
  const key = document.getElementById("key");
  const reveal = document.getElementById("reveal");
  if (!key || !reveal) return;
  const label = reveal.querySelector("span");
  reveal.hidden = false;
  reveal.addEventListener("click", () => {
    const show = key.type === "password";
    key.type = show ? "text" : "password";
    label.textContent = show ? "Hide" : "Show";
    key.focus();
  });
  let sent = false;
  key.form.addEventListener("submit", (event) => {
    if (sent) return event.preventDefault();
    sent = true;
    key.type = "password";
    const button = key.form.querySelector("button[type=submit]");
    button.textContent = "Checking\\u2026";
    button.setAttribute("aria-disabled", "true");
  });
})();`;

const ICON = (paths: string, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const KEY = '<circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8 20 3m-4 4 3 3m-5.5-.5 2.5 2.5"/>';
const CHECK = '<path d="M20 6 9 17l-5-5"/>';
const EYE = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>';
const ALERT = '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5m0 3.5h.01"/>';

function link(url: string, text: string): string {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function formCard(view: PageView, csrf: string, error: string | undefined): string {
  const display = escapeHtml(view.display);
  const errorNote =
    error === undefined
      ? ""
      : `<div class="note bad" id="key-error" role="alert">${ICON(ALERT)}<p>${escapeHtml(error)}</p></div>`;
  const described = error === undefined ? "" : ' aria-describedby="key-error" aria-invalid="true"';
  return `<form class="card" method="post" action="" autocomplete="off">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<ol class="steps">
<li><div class="step"><span class="step-title">Get a key</span><span class="muted">Create one on ${link(view.keysUrl, `the ${display} API keys page`)}.</span></div></li>
<li><div class="step"><label class="step-title" for="key">Paste it here</label>
<div class="field${error === undefined ? "" : " invalid"}"><input type="password" id="key" name="key" autocomplete="off" required minlength="16" maxlength="512" autofocus spellcheck="false" autocapitalize="off" autocorrect="off"${described}>
<button type="button" class="reveal" id="reveal" aria-controls="key" hidden>${ICON(EYE, 15)}<span>Show</span></button></div>
${errorNote}
<button type="submit" class="btn">Check and save</button></div></li>
<li><div class="step"><span class="step-title">Go back to Claude Code</span><span class="muted">Setup continues there by itself.</span></div></li>
</ol>
</form>`;
}

function savedCard(view: PageView, limited: boolean): string {
  const limitNote = limited
    ? `<div class="note warn" role="status">${ICON(ALERT)}<p>${escapeHtml(view.display)} is not taking requests with this key yet: a rate limit, or no balance left. Top up at ${link(view.billingUrl, escapeHtml(view.billingUrl))}.</p></div>`
    : "";
  return `<section class="card" aria-labelledby="saved">
<div class="done" role="status"><h2 id="saved">Saved in ${escapeHtml(view.storeLabel)}.</h2>
<p>You can close this tab; setup continues in Claude Code.</p></div>
${limitNote}
</section>`;
}

function endedCard(text: string): string {
  return `<section class="card"><div class="note bad" role="alert">${ICON(ALERT)}<p>${escapeHtml(text)}</p></div></section>`;
}

export function renderPage(view: PageView, nonce: string): string {
  const display = escapeHtml(view.display);
  const { state } = view;
  const saved = state.kind === "saved";
  const card =
    state.kind === "form"
      ? formCard(view, state.csrf, state.error)
      : state.kind === "saved"
        ? savedCard(view, state.limited)
        : endedCard(state.text);
  const title = saved ? `${display} connected` : `Connect ${display}`;
  const version = `${escapeHtml(view.plugin)}${view.version === undefined ? "" : ` v${escapeHtml(view.version)}`}`;
  const script = state.kind === "form" ? `\n<script nonce="${nonce}">${SCRIPT}</script>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="same-origin">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main class="signin"><div class="stack">
<div class="head"><span class="logo${saved ? " ok" : ""}">${ICON(saved ? CHECK : KEY, 30)}</span><h1>${title}</h1>
<p class="lead">Claude Code uses this key to send work to ${display}.</p></div>
${card}
<div class="foot"><p>Works once, on this machine only. The key is never shown, logged or sent to the chat.</p><p>${version}</p></div>
</div></main>${script}
</body>
</html>
`;
}
