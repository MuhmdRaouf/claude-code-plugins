import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readModelLine, writeModelLine } from "../../src/adapters/agent-files.ts";
import { tempDir } from "../support/tmp.ts";

describe("an agent file's model line", () => {
  it("reads, rewrites and removes the first model: line", () => {
    const file = join(tempDir("agent-files-"), "a.md");
    writeFileSync(file, "---\nname: a\nmodel:  opus \n---\nmodel: body\n");
    expect(readModelLine(file)).toBe("opus");
    expect(writeModelLine(file, "glm")).toEqual({ ok: true, value: true });
    expect(writeModelLine(file, "glm")).toEqual({ ok: true, value: false });
    expect(writeModelLine(file, null)).toEqual({ ok: true, value: true });
    expect(readFileSync(file, "utf8")).toBe("---\nname: a\n---\nmodel: body\n");
  });

  it("adds no line where there is none, and says when the file is missing", () => {
    const dir = tempDir("agent-files-");
    const file = join(dir, "b.md");
    writeFileSync(file, "---\nname: b\n---\n");
    expect(readModelLine(file)).toBeNull();
    expect(writeModelLine(file, null)).toEqual({ ok: true, value: false });
    expect(writeModelLine(file, "glm")).toEqual({ ok: false, error: `${file}: no model: line` });
    const missing = join(dir, "missing.md");
    expect(readModelLine(missing)).toBeUndefined();
    expect(writeModelLine(missing, "glm")).toEqual({ ok: false, error: `${missing}: not found` });
  });
});
