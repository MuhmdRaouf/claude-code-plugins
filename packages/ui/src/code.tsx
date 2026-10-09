/** The legacy span classes: keyword, string, number, comment, key/variable and parameter. */
export type TokenKind = "kw" | "str" | "num" | "com" | "key" | "param";

/** One highlighted run: its raw text and the class it wears, or null when plain. */
export type Token = { text: string; kind: TokenKind | null };

const KIND_CLASS: Record<TokenKind, string> = {
  kw: "hk",
  str: "hs",
  num: "hn",
  com: "hc",
  key: "hv",
  param: "hp",
};

const HCL_HEADS =
  "resource|module|variable|output|locals|provider|data|terraform|required_providers|backend|dynamic|for_each|count|depends_on|lifecycle";
const SH_COMMANDS =
  "make|ssh|curl|kubectl|docker|nix|git|export|cd|bun|npm|npx|node|huddle|huddle-mcp|claude";
const NIX_WORDS = "let|in|with|inherit|rec|import|if|then|else";
const TS_WORDS =
  "const|let|var|function|return|if|else|for|while|import|export|from|async|await|new|class|type";
const BOOL_WORDS = "true|false|null";

/**
 * Byte offset where a line comment starts, or -1. `#` comments every language except json, ts and js and
 * only at a word start; `//` only hcl, ts and js. Quotes hide both, and an escaped quote does not close one.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one scan over the line, as the legacy runs it
function commentIdx(line: string, lang: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (quote) {
      if (c === quote && line.charAt(i - 1) !== "\\") quote = null;
      continue;
    }
    if (c === '"' || (c === "'" && lang !== "hcl" && lang !== "make")) quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line.charAt(i - 1))) && !/^(json|ts|js)$/.test(lang))
      return i;
    else if (c === "/" && line.charAt(i + 1) === "/" && /^(hcl|ts|js)$/.test(lang)) return i;
  }
  return -1;
}

/** The tokens a language only recognises at the start of a line: maybe a plain prefix, then the word. */
function lineStartTokens(line: string, lang: string): Token[] | null {
  const head = (words: string): Token[] | null => {
    const m = new RegExp(`^(\\s*)(?:${words})\\b`).exec(line);
    if (!m) return null;
    const pad = m[1] || "";
    return [...(pad ? [{ text: pad, kind: null }] : []), { text: m[0].slice(pad.length), kind: "kw" }];
  };
  const name = (open: string, re: string, tail: RegExp, kind: TokenKind): Token[] | null => {
    const m = new RegExp(`^(${open})(${re})`).exec(line);
    if (!m || !tail.test(line.slice(m[0].length))) return null;
    const pad = m[1] || "";
    return [...(pad ? [{ text: pad, kind: null }] : []), { text: m[0].slice(pad.length), kind }];
  };
  if (lang === "hcl" || lang === "tf" || lang === "terraform") {
    return head(HCL_HEADS) ?? name("\\s*", "[\\w-]+", /^\s*=/, "key");
  }
  if (lang === "yaml" || lang === "yml") return name("\\s*-?\\s*", "[\\w./@-]+", /^:(?=\s|$)/, "key");
  if (lang === "nix") return name("", NIX_WORDS, /^(?!\w)/, "kw") ?? name("\\s*", "[\\w.-]+", /^\s*=/, "key");
  if (lang === "make" || lang === "makefile") return name("", "[\\w.-]+", /^:/, "kw");
  if (/^(sh|bash|shell|zsh)$/.test(lang)) return head(SH_COMMANDS);
  return null;
}

/** True when the character before `i` may open a whole-word match (start of line or a non-word char). */
function atWordStart(line: string, i: number): boolean {
  return i === 0 || !/\w/.test(line.charAt(i - 1));
}

/** Length of the string starting at `i`, or 0. Double quotes honour `\"`; single quotes take the next quote. */
function stringAt(line: string, i: number): number {
  const q = line.charAt(i);
  if (q === '"') {
    for (let j = i + 1; j < line.length; j++) {
      if (line.charAt(j) === "\\") j += 1;
      else if (line.charAt(j) === '"') return j + 1 - i;
    }
    return 0;
  }
  if (q === "'") {
    const end = line.indexOf("'", i + 1);
    return end < 0 ? 0 : end + 1 - i;
  }
  return 0;
}

/** A number when it stands alone: not inside a word, delimited as the legacy look-arounds required. */
function numberAt(line: string, i: number): number {
  if (i > 0 && !/[\s=:[,(]/.test(line.charAt(i - 1))) return 0;
  const m = /^\d+(?:\.\d+)*/.exec(line.slice(i));
  if (!m) return 0;
  const len = m[0].length;
  const after = line.charAt(i + len);
  return after === "" || /[\s,)\]]/.test(after) ? len : 0;
}

/** Length of a whole-word literal from `words` at `i`, else 0. */
function wordAt(line: string, i: number, words: string): number {
  if (!atWordStart(line, i)) return 0;
  const m = new RegExp(`^(?:${words})\\b`).exec(line.slice(i));
  return m ? m[0].length : 0;
}

/** Length of the language's keyword at `i`, else 0 (nix and ts have keyword lists). */
function keywordAt(line: string, lang: string, i: number): number {
  const words = lang === "nix" ? NIX_WORDS : /^(ts|js|typescript|javascript)$/.test(lang) ? TS_WORDS : null;
  if (!words || !atWordStart(line, i)) return 0;
  const m = new RegExp(`^(?:${words})\\b`).exec(line.slice(i));
  return m ? m[0].length : 0;
}

/** Length of a parameter at `i`: `$(…)` in make, a flag after a space in sh. Else 0. */
function paramAt(line: string, lang: string, i: number): number {
  if (lang === "make" || lang === "makefile") return /^\$\([^)]*\)/.exec(line.slice(i))?.[0]?.length ?? 0;
  if (/^(sh|bash|shell|zsh)$/.test(lang) && i > 0 && /\s/.test(line.charAt(i - 1))) {
    return /^--?[\w-]+/.exec(line.slice(i))?.[0]?.length ?? 0;
  }
  return 0;
}

/** Tokenize one line's code (any comment already split off); earlier patterns win, plain text takes the rest. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the legacy chain of replaces, leftmost wins
function tokenizeLine(line: string, lang: string): Token[] {
  const out: Token[] = [];
  const push = (text: string, kind: TokenKind | null) => {
    if (!text) return;
    out.push({ text, kind });
  };
  let plain = "";
  const flush = () => {
    if (plain) push(plain, null);
    plain = "";
  };
  let i = 0;
  for (const tok of lineStartTokens(line, lang) ?? []) {
    push(tok.text, tok.kind);
    i += tok.text.length;
  }
  while (i < line.length) {
    const strLen = stringAt(line, i);
    if (strLen) {
      const text = line.slice(i, i + strLen);
      flush();
      push(text, lang === "json" && /^\s*:/.test(line.slice(i + strLen)) ? "key" : "str");
      i += strLen;
      continue;
    }
    const kwLen = keywordAt(line, lang, i);
    if (kwLen) {
      flush();
      push(line.slice(i, i + kwLen), "kw");
      i += kwLen;
      continue;
    }
    const paramLen = paramAt(line, lang, i);
    if (paramLen) {
      flush();
      push(line.slice(i, i + paramLen), "param");
      i += paramLen;
      continue;
    }
    const numLen = numberAt(line, i) || wordAt(line, i, BOOL_WORDS);
    if (numLen) {
      flush();
      push(line.slice(i, i + numLen), "num");
      i += numLen;
      continue;
    }
    plain += line.charAt(i);
    i += 1;
  }
  flush();
  return out;
}

/**
 * Highlight `code` for `lang`, one array of tokens per line — the offline `hl` of the legacy file, returning
 * structure instead of HTML. Languages it knows: hcl (tf, terraform), yaml, nix, make, sh, ts and json; any
 * other still gets strings, numbers and true/false/null.
 */
export function highlight(code: string, lang: string): Token[][] {
  const L2 = (lang || "").toLowerCase();
  return String(code)
    .split("\n")
    .map((line) => {
      const ci = commentIdx(line, L2);
      const tokens = tokenizeLine(ci >= 0 ? line.slice(0, ci) : line, L2);
      if (ci >= 0) tokens.push({ text: line.slice(ci), kind: "com" });
      return tokens;
    });
}

/** File path → highlighter language: hcl, yaml, nix, make, json, sh or ts; "" when none applies. */
export function langOf(path: string): string {
  if (/\.tf$|\.hcl$|\.tftest/.test(path)) return "hcl";
  if (/\.ya?ml$/.test(path)) return "yaml";
  if (/\.nix$/.test(path)) return "nix";
  if (/Makefile$/.test(path)) return "make";
  if (/\.json$/.test(path)) return "json";
  if (/\.sh$/.test(path)) return "sh";
  if (/\.[jt]sx?$/.test(path)) return "ts";
  return "";
}

/** A fenced code block: line numbers down the left, highlighted text, the same `.code` markup as the legacy. */
export function CodeBlock({
  code,
  lang,
  start = 1,
  class: cls = "",
}: {
  code: string;
  lang: string;
  start?: number;
  class?: string;
}) {
  const lines = highlight(code, lang);
  return (
    <pre class={`code${cls ? ` ${cls}` : ""}`}>
      {lines.flatMap((line, i) => {
        const el = (
          <span key={i}>
            <span class="ln">{start + i}</span>
            {line.map((tok, j) =>
              tok.kind ? (
                <span key={j} class={KIND_CLASS[tok.kind]}>
                  {tok.text}
                </span>
              ) : (
                tok.text
              ),
            )}
          </span>
        );
        return i === 0 ? [el] : ["\n", el];
      })}
    </pre>
  );
}
