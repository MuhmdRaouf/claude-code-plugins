// The one page: inline HTML and one nonce'd style block. No scripts, no external URLs, no fonts, no images.

export interface PageView {
  readonly display: string;
  readonly storeLabel: string;
  /** The form's CSRF value; absent once there is no form to show. */
  readonly csrf?: string;
  readonly message?: { readonly kind: "error" | "done"; readonly text: string };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
:root { color-scheme: light dark; }
body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; }
h1 { font-size: 1.3rem; }
label { display: block; margin: 1.2rem 0 .4rem; font-weight: 600; }
input[type=password] { width: 100%; box-sizing: border-box; padding: .6rem; font: inherit; }
button { margin-top: 1rem; padding: .6rem 1.2rem; font: inherit; cursor: pointer; }
.error { color: #c0392b; font-weight: 600; }
.done { color: #1e8449; font-weight: 600; }
.note { opacity: .75; font-size: .9rem; }
`;

export function renderPage(view: PageView, nonce: string): string {
  const display = escapeHtml(view.display);
  const message =
    view.message === undefined
      ? ""
      : `<p class="${view.message.kind}" role="status">${escapeHtml(view.message.text)}</p>`;
  const form =
    view.csrf === undefined
      ? ""
      : `<form method="post" action="" autocomplete="off">
<input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
<label for="key">${display} API key</label>
<input type="password" id="key" name="key" autocomplete="off" required minlength="16" maxlength="512" autofocus spellcheck="false">
<button type="submit">Check and save</button>
</form>
<p class="note">The key is checked with one small request, then kept in ${escapeHtml(view.storeLabel)}. It is never shown,
logged or sent to the chat. This page works once and only on this machine.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${display} key</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<h1>${display} key</h1>
${message}
${form}
</body>
</html>
`;
}
