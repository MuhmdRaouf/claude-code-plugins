import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFsJobFiles } from "../../src/adapters/fs-job-files.ts";
import { reportContract, reportSchema } from "../../src/app/report-schema.ts";

const FILES = createFsJobFiles(tmpdir());

async function schemaFile(value: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "zai-schema-")), "report.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe("reportSchema", () => {
  it("returns a built-in as draft-07", async () => {
    const result = await reportSchema(FILES, { kind: "builtin", name: "sweep" });
    expect(result.ok && result.value.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("accepts a schema file with no $schema or a draft-07 one", async () => {
    for (const $schema of [undefined, "http://json-schema.org/draft-07/schema#"]) {
      const path = await schemaFile({ $schema, type: "object" });
      expect((await reportSchema(FILES, { kind: "file", path })).ok).toBe(true);
    }
  });

  it("rejects a schema file declaring another draft, before any worker starts (draft-07 is what every worker validates)", async () => {
    const path = await schemaFile({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
    });
    expect(await reportSchema(FILES, { kind: "file", path })).toEqual({
      ok: false,
      error: expect.stringContaining("draft-07"),
    });
  });

  it("explains the draft rule without naming a worker", async () => {
    const path = await schemaFile({ $schema: "https://json-schema.org/draft/2020-12/schema" });
    const result = await reportSchema(FILES, { kind: "file", path });
    const message = result.ok ? "" : result.error;

    expect(message).toMatch(/a report schema must be draft-07 \(.+\) or declare no \$schema$/);
    expect(message).not.toMatch(/claude|omp/i);
  });
});

describe("reportContract", () => {
  it("a schema file's contract is named by its path, carries the schema and checks only object-ness", async () => {
    const path = await schemaFile({ type: "object", required: ["answer"] });

    const result = await reportContract(FILES, { kind: "file", path });

    if (!result.ok) throw new Error(result.error);
    expect(result.value.name).toBe(path);
    expect(result.value.jsonSchema).toEqual({ type: "object", required: ["answer"] });
    expect(result.value.validate({ anything: 1 })).toEqual({ present: true, valid: true, problems: [] });
    expect(result.value.validate(null)).toMatchObject({ present: false, valid: false });
  });

  it("a schema the worker could not take is no contract", async () => {
    const path = await schemaFile(["not", "an", "object"]);

    expect(await reportContract(FILES, { kind: "file", path })).toEqual({
      ok: false,
      error: `${path} must hold a JSON schema object`,
    });
  });
});
