import { z } from "zod";
import type { Brief, BuiltinReport } from "../domain/brief.ts";
import { parseJson } from "../domain/json.ts";
import { builtinJsonSchema, checkReport } from "../domain/reports.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { JobFiles, ReportContract } from "../ports/index.ts";

/** The brief's report as the worker receives it: its name, its schema and the core's check. */
export async function reportContract(
  files: Pick<JobFiles, "readText">,
  report: Brief["report"],
): Promise<Result<ReportContract, string>> {
  if (report.kind === "builtin") return ok(builtinContract(report.name));
  const schema = await reportSchema(files, report);
  if (!schema.ok) return schema;
  return ok({ name: report.path, jsonSchema: schema.value, validate: (value) => checkReport(value, report) });
}

export function builtinContract(name: BuiltinReport): ReportContract {
  return {
    name,
    jsonSchema: builtinJsonSchema(name),
    validate: (value) => checkReport(value, { kind: "builtin", name }),
  };
}

/** The JSON schema the worker's report must follow: a built-in, or the brief's schema file, which
 *  must hold a JSON object in draft-07 or with no `$schema`. */
export async function reportSchema(
  files: Pick<JobFiles, "readText">,
  report: Brief["report"],
): Promise<Result<Record<string, unknown>, string>> {
  if (report.kind === "builtin") return ok(builtinJsonSchema(report.name));
  const text = await files.readText(report.path);
  if (!text.ok) return err(`cannot read ${report.path}: ${text.error}`);
  const value = parseJson(text.value, JsonObject);
  if (value === undefined) return err(`${report.path} must hold a JSON schema object`);
  const declared = value.$schema;
  if (declared !== undefined && declared !== DRAFT_07) {
    return err(
      `${report.path} declares $schema ${JSON.stringify(declared)}; a report schema must be draft-07 (${DRAFT_07}) or declare no $schema`,
    );
  }
  return ok(value);
}

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

const JsonObject = z.record(z.string(), z.unknown());
