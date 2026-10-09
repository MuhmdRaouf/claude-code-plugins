import { z } from "zod";

/** The parts of a worker report that every built-in contract shares; custom reports may have them too. */
const Shared = z.object({
  summary: z.string().optional().catch(undefined),
  open_items: z.array(z.string()).optional().catch(undefined),
  tests_added: z.array(z.string()).optional().catch(undefined),
});

interface ReportFacts {
  readonly summary?: string;
  readonly openItems: readonly string[];
  readonly testsAdded: readonly string[];
}

export interface SweepItem {
  readonly id: string;
  readonly status: "ok" | "fail" | "gap";
  readonly detail: string;
}

const WithItems = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        status: z.enum(["ok", "fail", "gap"]),
        detail: z.string(),
      }),
    )
    .optional()
    .catch(undefined),
});

/** Summary, open items and added tests of a report of any shape; whatever is missing or malformed is left out. */
export function reportFacts(report: unknown): ReportFacts {
  const parsed = Shared.safeParse(report);
  if (!parsed.success) return { openItems: [], testsAdded: [] };
  const summary = parsed.data.summary?.trim();
  return {
    ...(summary === undefined || summary === "" ? {} : { summary }),
    openItems: parsed.data.open_items ?? [],
    testsAdded: parsed.data.tests_added ?? [],
  };
}

/** The sweep items of a report of any shape; undefined when it has none (it is not a sweep report). */
export function sweepItems(report: unknown): readonly SweepItem[] | undefined {
  const parsed = WithItems.safeParse(report);
  return parsed.success ? parsed.data.items : undefined;
}
