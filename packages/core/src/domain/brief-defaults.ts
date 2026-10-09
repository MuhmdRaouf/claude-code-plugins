import type { Brief, BriefContext, BuiltinReport, Mode } from "./brief.ts";
import type { FrontMatter } from "./brief-schema.ts";

export const DEFAULT_TIMEOUT_MS = 2 * 3_600_000;
export const DEFAULT_BASE = "HEAD";
export const DEFAULT_RETRIES = { fix: 1, infra: 2 } as const;
export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;

export const DEFAULT_REPORT: Readonly<Record<Mode, BuiltinReport>> = {
  edit: "change",
  exec: "sweep",
  readonly: "notes",
};
export const DEFAULT_SCOPE: Readonly<Record<Mode, readonly string[]>> = {
  edit: ["**"],
  exec: [],
  readonly: [],
};

/** Fill the defaults that depend on the mode (and the caller's directory and provider). */
export function withDefaults(fields: FrontMatter, body: string, ctx: BriefContext): Brief {
  const { mode, effort, budgetUsd, setup, regenerate, priority, engine } = fields;
  return {
    title: fields.title,
    body,
    model: fields.model ?? ctx.provider.defaultTier[mode],
    ...(effort === undefined ? {} : { effort }),
    mode,
    ...(priority === undefined ? {} : { priority }),
    cwd: fields.cwd ?? ctx.defaultCwd,
    base: fields.base,
    scope: fields.scope ?? DEFAULT_SCOPE[mode],
    forbid: fields.forbid,
    gates: fields.gates,
    ...(setup === undefined ? {} : { setup }),
    ...(regenerate === undefined ? {} : { regenerate }),
    timeoutMs: fields.timeout,
    retries: fields.retries,
    report: fields.report ?? { kind: "builtin", name: DEFAULT_REPORT[mode] },
    addDirs: fields.addDirs,
    env: fields.env,
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    tags: fields.tags,
    // claude stays implicit, so a claude job's brief reads exactly as it did before engines existed.
    ...(engine === undefined || engine === "claude" ? {} : { engine }),
  };
}
