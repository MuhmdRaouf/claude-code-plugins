import { z } from "zod";
import type { BuiltinReport } from "./brief.ts";
import type { ReportCheck } from "./job.ts";
import { BUILTIN_REPORTS } from "./reports-schemas.ts";

/**
 * Built-in report contracts, defined once with zod and exported as JSON Schema for the worker (ReportContract.jsonSchema).
 * - change: { summary, files: [{path, why}], root_cause?, tests_added: string[], open_items: string[] }
 * - sweep: { summary, items: [{id, status: "ok"|"fail"|"gap", detail}], open_items: string[] }
 * - notes: { summary, findings: [{title, detail, refs: string[]}], open_items: string[] }
 */
export function builtinJsonSchema(name: BuiltinReport): Record<string, unknown> {
  // Every worker's validator speaks draft-07; a 2020-12 `$schema` is rejected outright.
  return z.toJSONSchema(BUILTIN_REPORTS[name], { target: "draft-7" });
}

/** A custom schema was already enforced by the worker; only object-ness is ours to check. */
const anyObject = z.record(z.string(), z.unknown(), { error: "expected a JSON object" });

/**
 * Builtins are validated with their zod schema (problems as "path: message"). A custom schema file is trusted to have
 * been enforced by the worker, so only presence and object-ness are checked.
 */
export function checkReport(
  report: unknown,
  contract: { readonly kind: "builtin"; readonly name: BuiltinReport } | { readonly kind: "file" },
): ReportCheck {
  if (report === undefined || report === null) {
    return { present: false, valid: false, problems: ["no structured report"] };
  }
  const schema = contract.kind === "file" ? anyObject : BUILTIN_REPORTS[contract.name];
  const parsed = schema.safeParse(report);
  const problems = parsed.success ? [] : parsed.error.issues.map(describeIssue);
  return { present: true, valid: problems.length === 0, problems };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".");
  return `${path}: ${issue.message}`;
}
