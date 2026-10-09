import type { ComponentChild } from "preact";
import { CodeBlock } from "./code.tsx";

/** Group `i` of a match; every group in these patterns always takes part, so this settles noUncheckedIndexedAccess. */
const grp = (m: RegExpExecArray, i = 1): string => m[i] ?? "";

/** Inline text as VNodes: code spans win, then bold, emphasis and links — the `md` of the legacy file. */
export function Inline({ text }: { text?: string | null | undefined }) {
  return <>{inlineNodes(String(text ?? ""), false)}</>;
}

/** Blank-line separated paragraphs; single newlines become <br>; a muted "—" when nothing survives. */
export function Paragraphs({ text }: { text?: string | null | undefined }) {
  const paras = String(text ?? "")
    .split(/\n{2,}/)
    .filter((p) => p.trim());
  if (!paras.length) return <p class="hint">—</p>;
  return (
    <>
      {paras.map((p, i) => (
        <p key={i}>{inlineNodes(p, true)}</p>
      ))}
    </>
  );
}

/** Block markdown: headings, lists, tables, quotes and fenced code, wrapped in the legacy `.prose-h` div. */
export function Markdown({ text }: { text?: string | null | undefined }) {
  return <div class="prose-h">{blockNodes(String(text ?? ""))}</div>;
}

/** A string child, newlines turned into <br> where the caller wants hard breaks. */
function textNode(text: string, br: boolean): ComponentChild {
  if (!br) return text;
  const parts = text.split("\n");
  if (parts.length === 1) return text;
  return parts.flatMap((p, i) => (i === 0 ? [p] : [<br key={i} />, p]));
}

/** Scan `s` once, left to right; at each spot the first pattern that matches wins over literal text. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: md's four inline patterns, leftmost wins
function inlineNodes(s: string, br: boolean): ComponentChild[] {
  const out: ComponentChild[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push(textNode(plain, br));
      plain = "";
    }
  };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      out.push(<code>{textNode(grp(code), br)}</code>);
      i += code[0].length;
      continue;
    }
    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    if (bold) {
      flush();
      out.push(<b>{textNode(grp(bold), br)}</b>);
      i += bold[0].length;
      continue;
    }
    const prev = i === 0 ? "" : s.charAt(i - 1);
    const em = i === 0 || /^[\s(]/.test(prev) ? /^\*([^*\s][^*]*)\*/.exec(rest) : null;
    if (em) {
      flush();
      out.push(<em>{textNode(grp(em), br)}</em>);
      i += em[0].length;
      continue;
    }
    // a word boundary before "http", exactly the anchors md could ever produce
    const link = i === 0 || !/\w/.test(prev) ? /^https?:\/\/[^\s<)]+/.exec(rest) : null;
    if (link?.[0]) {
      flush();
      out.push(
        <a href={link[0]} target="_blank" rel="noopener noreferrer">
          {textNode(link[0], br)}
        </a>,
      );
      i += link[0].length;
      continue;
    }
    plain += s.charAt(i);
    i += 1;
  }
  flush();
  return out;
}

/** One list item: its inline children and the indent style the legacy put on `ul` items. */
type Item = { nodes: ComponentChild[]; style: string };

const FENCE_CLASS = "my-2 rounded-lg border border-line";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: mdBlock's line machine, ported as one loop
function blockNodes(src: string): ComponentChild[] {
  const out: ComponentChild[] = [];
  let list: "ul" | "ol" | null = null;
  let items: Item[] = [];
  let fence: { lang: string; lines: string[] } | null = null;
  let para: string[] = [];
  let quote = false;
  let table: string[][] | null = null;
  const inline = (s: string) => inlineNodes(s, false);

  const flushPara = () => {
    if (!para.length) return;
    const h = inline(para.join(" "));
    out.push(
      quote ? <blockquote class="border-l-2 border-line2 pl-3 text-muted">{h}</blockquote> : <p>{h}</p>,
    );
    para = [];
  };
  const endTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    out.push(
      <div class="my-2 overflow-x-auto">
        <table class="w-full text-left text-[13px]">
          <thead>
            <tr class="border-b border-line">
              {(head ?? []).map((c, i) => (
                <th key={i} class="px-2 py-1.5 font-semibold">
                  {inline(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} class="border-b border-line/60 align-top">
                {row.map((c, i) => (
                  <td key={i} class="px-2 py-1.5">
                    {inline(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    table = null;
  };
  const endList = () => {
    if (!list) return;
    out.push(
      list === "ul" ? (
        <ul>
          {items.map((item, i) => (
            <li key={i} style={item.style}>
              {item.nodes}
            </li>
          ))}
        </ul>
      ) : (
        <ol>
          {items.map((item, i) => (
            <li key={i}>{item.nodes}</li>
          ))}
        </ol>
      ),
    );
    list = null;
    items = [];
  };
  const close = () => {
    flushPara();
    endTable();
    endList();
  };
  const cells = (l: string) =>
    l
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const fenceBlock = (f: { lang: string; lines: string[] }) => (
    <CodeBlock code={f.lines.join("\n")} lang={f.lang} start={1} class={FENCE_CLASS} />
  );

  for (const raw of src.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const l = raw.replace(/\s+$/, "");
    if (fence) {
      if (/^```/.test(l)) {
        out.push(fenceBlock(fence));
        fence = null;
      } else fence.lines.push(raw);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      if (!table) {
        close();
        table = [];
      }
      if (!/^[\s|:-]+$/.test(l)) table.push(cells(l));
      continue;
    }
    if (table) endTable();
    if (list && /^\s{2,}\S/.test(raw) && !/^\s*([-*]|\d+\.)\s/.test(l)) {
      const last = items[items.length - 1];
      if (last) last.nodes.push(" ", inline(l.trim()));
      continue;
    }
    const open = /^```(\w*)/.exec(l);
    if (open) {
      close();
      fence = { lang: grp(open), lines: [] };
      continue;
    }
    if (!l.trim()) {
      close();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(l);
    if (heading) {
      close();
      const n = Math.min(grp(heading).length + 1, 4);
      const h = inline(grp(heading, 2));
      out.push(n === 2 ? <h2>{h}</h2> : n === 3 ? <h3>{h}</h3> : <h4>{h}</h4>);
      continue;
    }
    const ul = /^(\s*)[-*]\s+(.*)$/.exec(l);
    if (ul) {
      if (list !== "ul") {
        close();
        list = "ul";
        items = [];
      }
      items.push({ nodes: inline(grp(ul, 2)), style: `margin-left:${grp(ul).length * 8}px` });
      continue;
    }
    const ol = /^\s*\d+\.\s+(.*)$/.exec(l);
    if (ol) {
      if (list !== "ol") {
        close();
        list = "ol";
        items = [];
      }
      items.push({ nodes: inline(grp(ol)), style: "" });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(l);
    if (list || (para.length && !!q !== quote)) close();
    quote = !!q;
    para.push(q ? grp(q) : l.trim());
  }
  if (fence) out.push(fenceBlock(fence));
  close();
  return out;
}
