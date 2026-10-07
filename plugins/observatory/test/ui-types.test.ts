import { describe, expect, it } from "vitest";
import { el, leaf } from "../src/ui/types.ts";

describe("el", () => {
  it("builds a node with only the fields it was given", () => {
    expect(el("div")).toEqual({ tag: "div" });
    expect(el("span", "chip")).toEqual({ tag: "span", cls: "chip" });
    expect(el("main", "body", [leaf("p", "x", "hi")])).toEqual({
      tag: "main",
      cls: "body",
      children: [{ tag: "p", cls: "x", text: "hi" }],
    });
    expect(el("button", "row", [], { "data-action": "tab" })).toEqual({
      tag: "button",
      cls: "row",
      children: [],
      attrs: { "data-action": "tab" },
    });
  });
});

describe("leaf", () => {
  it("is el with a class and text in one call", () => {
    expect(leaf("td", "num", "42")).toEqual({ tag: "td", cls: "num", text: "42" });
    expect(leaf("td", "num", "42", { title: "four-two" })).toEqual({
      tag: "td",
      cls: "num",
      text: "42",
      attrs: { title: "four-two" },
    });
  });
});
