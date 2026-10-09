import { render } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Inline, Markdown, Paragraphs } from "../src/markdown.tsx";

const $ = () => document.body;

describe("Inline", () => {
  it("wraps code spans, and nothing else runs inside them", () => {
    const { container } = render(<Inline text="run `git log` now" />);
    expect(container.querySelector("code")?.textContent).toBe("git log");
    render(<Inline text="`x *y*`" />);
    const code = $().querySelectorAll("code")[1];
    expect(code?.textContent).toBe("x *y*");
    expect(code?.querySelector("em")).toBeNull();
  });

  it("wraps bold and emphasis, emphasis only after a start, a space or an open paren", () => {
    render(<Inline text="a **b** c" />);
    expect($().querySelector("b")?.textContent).toBe("b");
    render(<Inline text="*lead* mid *also* (paren *in*)" />);
    const ems = [...$().querySelectorAll("em")].map((e) => e.textContent);
    expect(ems).toEqual(["lead", "also", "in"]);
    const plain = render(<Inline text="a*not*" />);
    expect(plain.container.querySelector("em")).toBeNull();
    expect(plain.container.textContent).toBe("a*not*");
  });

  it("keeps nested emphasis literal inside bold and splits adjacent stars like the legacy", () => {
    render(<Inline text="**bold *in* after**" />);
    expect($().querySelector("b")).toBeNull();
    expect($().querySelector("em")?.textContent).toBe("in");
    expect($().textContent).toContain("**bold");
    render(<Inline text="***x***" />);
    expect($().querySelector("b")?.textContent).toBe("x");
  });

  it("links http(s) in a new tab, stops at a close paren and skips mid-word occurrences", () => {
    const { container } = render(<Inline text="see https://x.io/a_b?q=1 now" />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://x.io/a_b?q=1");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a?.textContent).toBe("https://x.io/a_b?q=1");
    render(<Inline text="(open http://x.io/a)" />);
    const b = $().querySelectorAll("a")[1];
    expect(b?.getAttribute("href")).toBe("http://x.io/a");
    expect($().textContent).toContain(")");
    render(<Inline text="abchttp://x.io" />);
    expect($().querySelectorAll("a")).toHaveLength(2);
  });

  it("leaves unsafe schemes and other protocols as text", () => {
    render(<Inline text="javascript:alert(1) data:text/html,hi ftp://f.io/a" />);
    expect($().querySelector("a")).toBeNull();
    expect($().textContent).toBe("javascript:alert(1) data:text/html,hi ftp://f.io/a");
  });

  it("renders missing text as nothing", () => {
    const { container } = render(<Inline text={undefined} />);
    expect(container.textContent).toBe("");
  });
});

describe("Paragraphs", () => {
  it("splits on blank lines and drops blank paragraphs", () => {
    const { container } = render(<Paragraphs text={"\n\n a \n\n\n\n b "} />);
    const ps = container.querySelectorAll("p");
    expect(ps).toHaveLength(2);
    expect(ps[0]?.textContent?.trim()).toBe("a");
    expect(ps[1]?.textContent?.trim()).toBe("b");
  });

  it("turns single newlines into br, also inside a code span", () => {
    const { container } = render(<Paragraphs text={"x **y**\nmore"} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("b")?.textContent).toBe("y");
    expect(container.querySelector("br")).not.toBeNull();
    render(<Paragraphs text={"`a\nb`"} />);
    expect($().querySelectorAll("p")[1]?.querySelector("code br")).not.toBeNull();
  });

  it("falls back to a muted dash when nothing survives", () => {
    for (const text of [undefined, null, "", "  \n "]) {
      const { container } = render(<Paragraphs text={text} />);
      expect(container.innerHTML).toBe('<p class="hint">—</p>');
    }
  });
});

describe("Markdown", () => {
  it("wraps everything in the .prose-h div and renders nothing for empty or missing text", () => {
    const { container } = render(<Markdown text="" />);
    expect(container.firstElementChild?.className).toBe("prose-h");
    expect(container.firstElementChild?.children).toHaveLength(0);
    render(<Markdown text={undefined} />);
    expect($().querySelectorAll(".prose-h")[1]?.children).toHaveLength(0);
  });

  it("maps # to h2 up to #### to h4, and leaves five hashes a paragraph", () => {
    render(<Markdown text={["# one", "## two", "### three", "#### four", "##### five"].join("\n")} />);
    expect($().querySelector("h2")?.textContent).toBe("one");
    expect($().querySelector("h3")?.textContent).toBe("two");
    expect($().querySelector("h4")?.textContent).toBe("three");
    expect($().querySelectorAll("h4")).toHaveLength(2);
    expect($().querySelector("h5")).toBeNull();
    expect($().querySelector("p")?.textContent).toBe("##### five");
    render(<Markdown text="## **bold** head" />);
    expect($().querySelectorAll("h3")[1]?.querySelector("b")?.textContent).toBe("bold");
  });

  it("joins soft-wrapped lines into one paragraph with a space and no br", () => {
    const { container } = render(<Markdown text={"a\nb"} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("p")?.textContent).toBe("a b");
    expect(container.querySelector("br")).toBeNull();
  });

  it("opens one ul for - and * items, indenting each by four pixels per space", () => {
    render(<Markdown text={"- a\n  * b"} />);
    const ul = $().querySelector("ul");
    const items = ul?.querySelectorAll("li") ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute("style")).toBe("margin-left: 0px;");
    expect(items[1]?.getAttribute("style")).toBe("margin-left: 16px;");
  });

  it("folds an indented follow-up line into the item above", () => {
    const { container } = render(<Markdown text={"- a\n  cont"} />);
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(container.querySelector("li")?.textContent).toBe("a cont");
  });

  it("numbers ordered lists without an indent style, closing the ul before", () => {
    render(<Markdown text={"- a\n1. b\n2. c"} />);
    expect($().querySelectorAll("ul li")).toHaveLength(1);
    const ol = $().querySelector("ol");
    expect(ol?.querySelectorAll("li")).toHaveLength(2);
    expect(ol?.querySelector("li")?.getAttribute("style")).toBeNull();
  });

  it("treats an ordered marker on an indented line as a new list, not a continuation", () => {
    const { container } = render(<Markdown text={"- a\n  1. b"} />);
    expect(container.querySelectorAll("ul li")).toHaveLength(1);
    expect(container.querySelectorAll("ol li")).toHaveLength(1);
  });

  it("groups consecutive quote lines into one blockquote and closes it on a plain line", () => {
    render(<Markdown text={"> q1\n> q2\nword"} />);
    expect($().querySelectorAll("blockquote")).toHaveLength(1);
    const q = $().querySelector("blockquote");
    expect(q?.className).toBe("border-l-2 border-line2 pl-3 text-muted");
    expect(q?.textContent).toBe("q1 q2");
    expect($().querySelector("p")?.textContent).toBe("word");
    render(<Markdown text={"word\n> q"} />);
    const second = $().querySelectorAll(".prose-h")[1];
    expect(second?.querySelector("p")?.textContent).toBe("word");
    expect(second?.querySelector("blockquote")?.textContent).toBe("q");
  });

  it("renders a pipe table with the legacy table classes and drops the separator row", () => {
    const { container } = render(<Markdown text={"| h1 | h2 |\n| --- | --- |\n| a | **b** |"} />);
    const wrap = container.querySelector("div.my-2.overflow-x-auto");
    expect(wrap).not.toBeNull();
    const table = wrap?.querySelector("table.w-full.text-left.text-\\[13px\\]");
    expect(table).not.toBeNull();
    expect(table?.querySelector("thead tr")?.className).toBe("border-b border-line");
    const heads = table?.querySelectorAll("th") ?? [];
    expect([...heads].map((th) => th.textContent)).toEqual(["h1", "h2"]);
    expect(heads[0]?.className).toBe("px-2 py-1.5 font-semibold");
    const row = table?.querySelector("tbody tr");
    expect(row?.className).toBe("border-b border-line/60 align-top");
    expect(row?.querySelector("td")?.className).toBe("px-2 py-1.5");
    expect(row?.querySelectorAll("td")[1]?.querySelector("b")?.textContent).toBe("b");
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("ends the table when a non-table line arrives, and keeps pipe-less lines a paragraph", () => {
    const { container } = render(<Markdown text={"| a |\n| - |\n| 1 |\nword"} />);
    expect(container.querySelectorAll("td")).toHaveLength(1);
    expect(container.querySelector("p")?.textContent).toBe("word");
    render(<Markdown text="a | b" />);
    expect($().querySelectorAll(".prose-h")[1]?.querySelector("table")).toBeNull();
    expect($().querySelectorAll(".prose-h")[1]?.querySelector("p")?.textContent).toBe("a | b");
  });

  it("renders a separator-only table as an empty thead and no body rows", () => {
    const { container } = render(<Markdown text={"| - |\nword"} />);
    expect(container.querySelector("thead tr")?.children).toHaveLength(0);
    expect(container.querySelector("tbody")?.children).toHaveLength(0);
    expect(container.querySelector("p")?.textContent).toBe("word");
  });

  it("renders a fenced block through CodeBlock and leaves its text unprocessed", () => {
    const { container } = render(<Markdown text={"```sh\ngit log\n```"} />);
    const pre = container.querySelector("pre");
    expect(pre?.className).toBe("code my-2 rounded-lg border border-line");
    expect(pre?.querySelector(".ln")?.textContent).toBe("1");
    expect(pre?.querySelector(".hk")?.textContent).toBe("git");
    render(<Markdown text={"```\n**b**\n```"} />);
    const plain = $().querySelectorAll(".prose-h")[1]?.querySelector("pre");
    expect(plain?.textContent).toContain("**b**");
    expect(plain?.querySelector("b")).toBeNull();
  });

  it("still renders a fence that never closes", () => {
    const { container } = render(<Markdown text={"```sh\ngit status"} />);
    expect(container.querySelector("pre.code")).not.toBeNull();
    expect(container.querySelector(".ln")?.textContent).toBe("1");
    expect(container.querySelector(".hk")?.textContent).toBe("git");
  });

  it("strips html comments before looking at the lines", () => {
    const { container } = render(<Markdown text={"<!-- hide\neverything -->\nshow"} />);
    expect(container.textContent).not.toContain("hide");
    expect(container.textContent).toContain("show");
  });

  it("closes an open list at a blank line", () => {
    const { container } = render(<Markdown text={"- a\n\nb"} />);
    expect(container.querySelectorAll("ul li")).toHaveLength(1);
    expect(container.querySelector("p")?.textContent).toBe("b");
  });
});
