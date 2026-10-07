import { describe, expect, it } from "vitest";
import type { BuiltinReport } from "../../src/domain/brief.ts";
import { builtinJsonSchema, checkReport } from "../../src/domain/reports.ts";

const CHANGE: Parameters<typeof checkReport>[1] = { kind: "builtin", name: "change" };
const BUILTINS: readonly BuiltinReport[] = ["change", "sweep", "notes"];

const conformingChange = {
  summary: "Fixed the off-by-one",
  files: [{ path: "src/range.ts", why: "end bound was exclusive" }],
  tests_added: ["test/range.test.ts"],
  open_items: [],
};

describe("builtinJsonSchema", () => {
  it("targets JSON Schema draft-07, the only draft every worker's validator accepts (2020-12 crashed the live ping)", () => {
    for (const name of BUILTINS) {
      expect(builtinJsonSchema(name).$schema).toBe("http://json-schema.org/draft-07/schema#");
    }
  });
  it("change/sweep/notes produce JSON Schema objects with type object and required fields as documented", () => {
    expect(builtinJsonSchema("change")).toMatchObject({
      type: "object",
      required: ["summary", "files", "tests_added", "open_items"],
    });
    expect(builtinJsonSchema("sweep")).toMatchObject({
      type: "object",
      required: ["summary", "items", "open_items"],
    });
    expect(builtinJsonSchema("notes")).toMatchObject({
      type: "object",
      required: ["summary", "findings", "open_items"],
    });
  });
  it("the change schema matches the documented contract field by field", () => {
    expect(builtinJsonSchema("change")).toMatchInlineSnapshot(`
      {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "files": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "path": {
                  "type": "string",
                },
                "why": {
                  "type": "string",
                },
              },
              "required": [
                "path",
                "why",
              ],
              "type": "object",
            },
            "type": "array",
          },
          "open_items": {
            "items": {
              "type": "string",
            },
            "type": "array",
          },
          "root_cause": {
            "type": "string",
          },
          "summary": {
            "type": "string",
          },
          "tests_added": {
            "items": {
              "type": "string",
            },
            "type": "array",
          },
        },
        "required": [
          "summary",
          "files",
          "tests_added",
          "open_items",
        ],
        "type": "object",
      }
    `);
  });

  it("schemas disallow additional top-level properties", () => {
    for (const name of BUILTINS) {
      expect(builtinJsonSchema(name), name).toMatchObject({ additionalProperties: false });
    }
  });
});

describe("checkReport", () => {
  it("a conforming change report is present and valid", () => {
    expect(checkReport(conformingChange, CHANGE)).toEqual({ present: true, valid: true, problems: [] });
    expect(checkReport({ ...conformingChange, root_cause: "< instead of <=" }, CHANGE)).toEqual({
      present: true,
      valid: true,
      problems: [],
    });
  });
  it("undefined/null → present false, valid false", () => {
    const missing = { present: false, valid: false, problems: ["no structured report"] };

    expect(checkReport(undefined, CHANGE)).toEqual(missing);
    expect(checkReport(null, CHANGE)).toEqual(missing);
    expect(checkReport(null, { kind: "file" })).toEqual(missing);
  });
  it("a non-conforming builtin report lists problems as 'path: message'", () => {
    const report = { summary: "x", files: [{ path: "a.ts", why: 3 }], open_items: [], extra: true };

    expect(checkReport(report, CHANGE)).toEqual({
      present: true,
      valid: false,
      problems: [
        "files.0.why: Invalid input: expected string, received number",
        "tests_added: Invalid input: expected array, received undefined",
        '(root): Unrecognized key: "extra"',
      ],
    });
  });

  it("sweep and notes reports are validated against their own contracts", () => {
    const sweep = { summary: "s", items: [{ id: "a", status: "done", detail: "" }], open_items: [] };
    const notes = {
      summary: "n",
      findings: [{ title: "t", detail: "d", refs: ["src/a.ts:3"] }],
      open_items: [],
    };

    expect(checkReport(sweep, { kind: "builtin", name: "sweep" }).problems).toEqual([
      'items.0.status: Invalid option: expected one of "ok"|"fail"|"gap"',
    ]);
    expect(checkReport(notes, { kind: "builtin", name: "notes" })).toEqual({
      present: true,
      valid: true,
      problems: [],
    });
    expect(checkReport(notes, CHANGE).valid).toBe(false);
  });

  it("a builtin report that is not an object is invalid at the root", () => {
    expect(checkReport("done!", CHANGE)).toEqual({
      present: true,
      valid: false,
      problems: ["(root): Invalid input: expected object, received string"],
    });
  });
  it("custom contract: any object is valid; a non-object is invalid", () => {
    const FILE: Parameters<typeof checkReport>[1] = { kind: "file" };

    expect(checkReport({ anything: ["goes"] }, FILE)).toEqual({ present: true, valid: true, problems: [] });
    for (const notObject of ["text", 42, true, [{ a: 1 }]]) {
      expect(checkReport(notObject, FILE), JSON.stringify(notObject)).toEqual({
        present: true,
        valid: false,
        problems: ["(root): expected a JSON object"],
      });
    }
  });
});
