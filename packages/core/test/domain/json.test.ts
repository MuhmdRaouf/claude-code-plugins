import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJson } from "../../src/domain/json.ts";

describe("parseJson", () => {
  const Shape = z.object({ n: z.number() });

  it("returns the value when it parses and matches", () => {
    expect(parseJson('{"n":1}', Shape)).toEqual({ n: 1 });
  });

  it.each(["", "{ torn", '{"n":"one"}', "null", "[]"])("is undefined for %j", (text) => {
    expect(parseJson(text, Shape)).toBeUndefined();
  });
});
