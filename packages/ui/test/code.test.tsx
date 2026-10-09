import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { CodeBlock, highlight, langOf } from "../src/code.tsx";

/** The runs that carry a class, as "kind:text" strings. */
const marks = (code: string, lang: string) =>
  highlight(code, lang)
    .flat()
    .filter((t) => t.kind)
    .map((t) => `${t.kind}:${t.text}`);

describe("highlight — strings", () => {
  it("wraps double and single quoted strings", () => {
    expect(marks("a = \"hi there\", b = 'x'", "")).toEqual(['str:"hi there"', "str:'x'"]);
  });

  it("keeps an escaped quote inside a string and leaves an unterminated one as text", () => {
    expect(marks('say "a \\" b" now', "sh")).toEqual(['str:"a \\" b"']);
    expect(marks('say "no end', "sh")).toEqual([]);
  });

  it("marks a json object key whether the colon hugs, follows a space or precedes the string", () => {
    expect(marks('{"a":1, "b": [2], "c" :3}', "json")).toEqual([
      'key:"a"',
      "num:1",
      'key:"b"',
      "num:2",
      'key:"c"',
    ]);
  });

  it("marks nothing but strings for a language it does not know", () => {
    expect(marks('x = "v" + 1', "brainfuck")).toEqual(['str:"v"', "num:1"]);
  });
});

describe("highlight — numbers", () => {
  it("marks whole and dotted numbers after a delimiter and at line end", () => {
    expect(marks("a = 1, b 2.5.2 [3] (4)", "")).toEqual(["num:1", "num:2.5.2", "num:3", "num:4"]);
  });

  it("leaves digits inside words and before a letter alone", () => {
    expect(marks("v1 x2y 3z", "")).toEqual([]);
  });

  it("marks true, false and null as numbers", () => {
    expect(marks("true false null trueX", "json")).toEqual(["num:true", "num:false", "num:null"]);
  });
});

describe("highlight — comments", () => {
  it("takes # from line start or after a space, but not mid-word", () => {
    expect(marks("# all comment", "sh")).toEqual(["com:# all comment"]);
    expect(marks("git log # trailing", "sh")).toEqual(["kw:git", "com:# trailing"]);
    expect(marks("git log# not", "sh")).toEqual(["kw:git"]);
  });

  it("hides # inside quotes and honours escaped quotes", () => {
    expect(marks('echo "a # b" # real', "sh")).toEqual(['str:"a # b"', "com:# real"]);
    expect(marks('echo "a \\" # still open" # real', "sh")).toEqual([
      'str:"a \\" # still open"',
      "com:# real",
    ]);
  });

  it("never takes # in json, ts or js, and // only in hcl, ts and js", () => {
    expect(marks("{ } # x", "json")).toEqual([]);
    expect(marks("let x = 1 // note", "ts")).toEqual(["kw:let", "num:1", "com:// note"]);
    expect(marks("let x = 1 // note", "js")).toEqual(["kw:let", "num:1", "com:// note"]);
    expect(marks("a = 1 // note", "hcl")).toEqual(["key:a", "num:1", "com:// note"]);
    expect(marks("a = 1 // note", "sh")).toEqual(["num:1"]);
  });

  it("takes # in hcl and make even though a quote does not open there", () => {
    expect(marks("it's # fine", "hcl")).toEqual(["com:# fine"]);
    expect(marks("it's # fine", "make")).toEqual(["com:# fine"]);
    expect(marks("it's # open quote", "sh")).toEqual([]);
  });
});

describe("highlight — hcl", () => {
  it("marks a head block name and an assignment key, keeping punctuation outside", () => {
    expect(highlight('resource "aws_s3_bucket" "b" {', "hcl")).toEqual([
      [
        { text: "resource", kind: "kw" },
        { text: " ", kind: null },
        { text: '"aws_s3_bucket"', kind: "str" },
        { text: " ", kind: null },
        { text: '"b"', kind: "str" },
        { text: " {", kind: null },
      ],
    ]);
    expect(marks('name = "x"', "hcl")).toEqual(["key:name", 'str:"x"']);
  });

  it("marks count as a keyword and its number", () => {
    expect(marks("count = 5", "hcl")).toEqual(["kw:count", "num:5"]);
  });

  it("answers to tf and terraform and ignores case", () => {
    expect(marks('variable "a" {}', "tf")).toEqual(["kw:variable", 'str:"a"']);
    expect(marks("locals {}", "Terraform")).toEqual(["kw:locals"]);
  });
});

describe("highlight — yaml", () => {
  it("marks a key before a colon and inside a list item", () => {
    expect(marks("name: x", "yaml")).toEqual(["key:name"]);
    expect(marks("- name: x", "yml")).toEqual(["key:name"]);
    expect(marks("key:value", "yaml")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(marks("a: 1", "YAML")).toEqual(["key:a", "num:1"]);
  });
});

describe("highlight — nix", () => {
  it("marks keywords anywhere and an assignment key at line start", () => {
    expect(marks("let x = 1; in x", "nix")).toEqual(["kw:let", "kw:in"]);
    expect(marks("imports = ./.", "nix")).toEqual(["key:imports"]);
    expect(marks("foo.bar = 1", "nix")).toEqual(["key:foo.bar", "num:1"]);
  });

  it("prefers a keyword over a key at line start", () => {
    expect(marks("rec = 1", "nix")).toEqual(["kw:rec", "num:1"]);
  });
});

describe("highlight — make", () => {
  it("marks a target and a variable reference", () => {
    expect(marks("build: deps", "make")).toEqual(["kw:build"]);
    expect(marks("\\techo $(CC)", "make")).toEqual(["param:$(CC)"]);
    expect(marks("a: $(B)", "makefile")).toEqual(["kw:a", "param:$(B)"]);
  });

  it("does not mark an indented recipe line as a target", () => {
    expect(marks("\techo hi", "make")).toEqual([]);
  });
});

describe("highlight — sh", () => {
  it("marks a leading command and flags after a space", () => {
    expect(marks("curl --head http://x.io", "sh")).toEqual(["kw:curl", "param:--head"]);
    expect(marks('git commit -m "msg"', "zsh")).toEqual(["kw:git", "param:-m", 'str:"msg"']);
    expect(marks("echo hi", "shell")).toEqual([]);
    expect(marks("kubectl get pods", "bash")).toEqual(["kw:kubectl"]);
  });
});

describe("highlight — ts", () => {
  it("marks keywords and not the words that merely contain them", () => {
    expect(marks("const x = 1;", "ts")).toEqual(["kw:const"]);
    expect(marks("exported const", "ts")).toEqual(["kw:const"]);
    expect(marks("if (a) { return b }", "typescript")).toEqual(["kw:if", "kw:return"]);
  });
});

describe("highlight — structure", () => {
  it("returns one token array per line, comment split off the end", () => {
    expect(highlight("git log # a\nplain", "sh")).toEqual([
      [
        { text: "git", kind: "kw" },
        { text: " log ", kind: null },
        { text: "# a", kind: "com" },
      ],
      [{ text: "plain", kind: null }],
    ]);
  });

  it("keeps an empty line as an empty run", () => {
    expect(highlight("a\n\nb", "")).toEqual([[{ text: "a", kind: null }], [], [{ text: "b", kind: null }]]);
  });
});

describe("highlight — indented line starts", () => {
  it("marks an indented command, keeping the indent as a plain run", () => {
    expect(highlight("  git log", "sh")).toEqual([
      [
        { text: "  ", kind: null },
        { text: "git", kind: "kw" },
        { text: " log", kind: null },
      ],
    ]);
  });

  it("marks an indented head and an indented key like ones at the margin", () => {
    expect(marks("  locals {}", "hcl")).toEqual(["kw:locals"]);
    expect(marks('  name = "x"', "hcl")).toEqual(["key:name", 'str:"x"']);
    expect(marks("  key: v", "yaml")).toEqual(["key:key"]);
  });
});

describe("langOf", () => {
  it("maps every known extension and name", () => {
    expect(langOf("main.tf")).toBe("hcl");
    expect(langOf("main.hcl")).toBe("hcl");
    expect(langOf("a.b.tftest.hcl")).toBe("hcl");
    expect(langOf("x.yaml")).toBe("yaml");
    expect(langOf("x.yml")).toBe("yaml");
    expect(langOf("x.nix")).toBe("nix");
    expect(langOf("src/Makefile")).toBe("make");
    expect(langOf("x.json")).toBe("json");
    expect(langOf("x.sh")).toBe("sh");
    expect(langOf("x.ts")).toBe("ts");
    expect(langOf("x.tsx")).toBe("ts");
    expect(langOf("x.js")).toBe("ts");
    expect(langOf("x.jsx")).toBe("ts");
  });

  it("returns the empty string for anything else, including a lowercase makefile", () => {
    expect(langOf("x.txt")).toBe("");
    expect(langOf("x.yaml.bak")).toBe("");
    expect(langOf("makefile")).toBe("");
    expect(langOf("")).toBe("");
  });
});

describe("CodeBlock", () => {
  it("renders the legacy .code markup: a line number, then the highlighted line", () => {
    render(<CodeBlock code={"git log\nplain"} lang="sh" />);
    const pre = screen.getByText("git").closest("pre");
    expect(pre?.className).toBe("code");
    const lines = pre?.querySelectorAll(":scope > span") ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]?.querySelector(".ln")?.textContent).toBe("1");
    expect(lines[0]?.querySelector(".hk")?.textContent).toBe("git");
    expect(lines[1]?.querySelector(".ln")?.textContent).toBe("2");
    expect(lines[1]?.textContent).toBe("2plain");
  });

  it("numbers lines from start and appends the caller's class", () => {
    render(<CodeBlock code={"x = 1"} lang="hcl" start={41} class="my-2 rounded-lg border border-line" />);
    const pre = document.querySelector("pre.code");
    expect(pre?.className).toBe("code my-2 rounded-lg border border-line");
    expect(pre?.querySelector(".ln")?.textContent).toBe("41");
    expect(pre?.querySelector(".hv")?.textContent).toBe("x");
    expect(pre?.querySelector(".hn")?.textContent).toBe("1");
  });
});
