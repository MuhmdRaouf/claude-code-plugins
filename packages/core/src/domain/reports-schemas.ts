import { z } from "zod";
import type { BuiltinReport } from "./brief.ts";

const strings = z.array(z.string());

const changeReport = z.strictObject({
  summary: z.string(),
  files: z.array(z.strictObject({ path: z.string(), why: z.string() })),
  root_cause: z.string().optional(),
  tests_added: strings,
  open_items: strings,
});

const sweepReport = z.strictObject({
  summary: z.string(),
  items: z.array(
    z.strictObject({ id: z.string(), status: z.enum(["ok", "fail", "gap"]), detail: z.string() }),
  ),
  open_items: strings,
});

const notesReport = z.strictObject({
  summary: z.string(),
  findings: z.array(z.strictObject({ title: z.string(), detail: z.string(), refs: strings })),
  open_items: strings,
});

/**
 * The single definition of each built-in report: validated here, exported as JSON Schema for `--json-schema`. Strict
 * at every level, so validation rejects exactly what the schema's `additionalProperties: false` forbids.
 */
export const BUILTIN_REPORTS: Readonly<Record<BuiltinReport, z.ZodType>> = {
  change: changeReport,
  sweep: sweepReport,
  notes: notesReport,
};
