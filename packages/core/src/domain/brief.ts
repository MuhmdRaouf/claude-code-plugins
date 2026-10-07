import { parseDocument } from "yaml";
import { withDefaults } from "./brief-defaults.ts";
import { splitFrontMatter } from "./brief-front-matter.ts";
import { frontMatterSchema, requiredMessage, toBriefErrors } from "./brief-schema.ts";
import { renderBriefTemplate } from "./brief-template.ts";
import type { EngineTool } from "./engine.ts";
import type { ModelTier } from "./model.ts";
import type { Provider } from "./provider.ts";
import { err, ok, type Result } from "./result.ts";

export type Mode = "edit" | "exec" | "readonly";
export type BuiltinReport = "change" | "sweep" | "notes";
/** Where a job waits among other jobs competing for the same worker slots. */
export type Priority = "high" | "normal";

export interface Gate {
  readonly run: string;
  /** Milliseconds; default 10 minutes. */
  readonly timeoutMs: number;
}

/** A generated file the plugin recreates instead of merging as text when landing. */
interface RegenerateRule {
  /** Globs (picomatch, dotfiles included) naming the files `run` recreates. */
  readonly paths: readonly string[];
  readonly run: string;
}

export interface Brief {
  readonly title: string;
  readonly body: string;
  readonly model: ModelTier;
  /** One of the worker's efforts. */
  readonly effort?: string;
  readonly mode: Mode;
  /** Slot-queue priority; unset means the submitting command's default (high for run, normal for batch). */
  readonly priority?: Priority;
  /** Absolute repository path (resolved by the caller from `cwd` or the current git root). */
  readonly cwd: string;
  readonly base: string;
  readonly scope: readonly string[];
  readonly forbid: readonly string[];
  readonly gates: readonly Gate[];
  /** Commands run in order before the gates in every checkout the plugin verifies in (e.g. `npm ci`). Default: none. */
  readonly setup?: readonly string[];
  /** Generated files the plugin recreates (by running `run`) instead of merging as text when landing. Default: none. */
  readonly regenerate?: readonly RegenerateRule[];
  readonly timeoutMs: number;
  readonly retries: { readonly fix: number; readonly infra: number };
  readonly report:
    | { readonly kind: "builtin"; readonly name: BuiltinReport }
    | { readonly kind: "file"; readonly path: string };
  readonly addDirs: readonly string[];
  /** Names only. Values are read from the orchestrator's environment at run time and never persisted. */
  readonly env: readonly string[];
  readonly budgetUsd?: number;
  readonly tags: readonly string[];
  /** The delegation engine the job runs on; absent means claude (headless Claude Code). */
  readonly engine?: EngineTool;
}

/** Whether a brief reports in sweep items (ok/fail/gap), whose counts the compact output shows instead of gates. */
export function isSweepBrief(brief: Brief): boolean {
  return brief.report.kind === "builtin" && brief.report.name === "sweep";
}

/** What a worker accepts from a brief; its capabilities carry these, and brief parsing and the template read them. */
export interface WorkerTerms {
  /** The `effort` values, lowest first. */
  readonly efforts: readonly [string, ...string[]];
  /** `budgetUsd` is honoured; a brief that sets it is refused otherwise. */
  readonly budget: boolean;
  /** How the worker takes effort, addDirs, budgetUsd and readonly work, as the template explains each. */
  readonly briefNotes: {
    readonly effort: string;
    readonly addDirs: string;
    readonly budgetUsd: string;
    readonly readonly: string;
  };
}

export interface BriefContext {
  /** Absolute path used when the front matter has no `cwd`, and to resolve a relative one. */
  readonly defaultCwd: string;
  /** The tiers a brief may name (by tier name or model id) and the one it gets by default. */
  readonly provider: Pick<Provider, "catalog" | "tierNames" | "defaultTier">;
  readonly worker: WorkerTerms;
}

export type BriefError =
  | { readonly kind: "no_front_matter" }
  | { readonly kind: "yaml"; readonly message: string }
  | { readonly kind: "field"; readonly field: string; readonly message: string }
  | { readonly kind: "empty_body" };

/** Parse a brief document (YAML front matter + markdown body) and apply mode-dependent defaults. */
export function parseBrief(text: string, ctx: BriefContext): Result<Brief, readonly BriefError[]> {
  const document = splitFrontMatter(text);
  if (document === null) return err([{ kind: "no_front_matter" }]);
  const yaml = parseDocument(document.frontMatter);
  if (yaml.errors.length > 0)
    return err(yaml.errors.map((error) => ({ kind: "yaml", message: error.message })));
  const data: unknown = yaml.toJS();
  const fields = frontMatterSchema(ctx).safeParse(data ?? {}, { error: requiredMessage });
  const errors: BriefError[] = fields.success ? [] : [...toBriefErrors(fields.error)];
  if (document.body.trim() === "") errors.push({ kind: "empty_body" });
  if (!fields.success || errors.length > 0) return err(errors);
  return ok(withDefaults(fields.data, document.body, ctx));
}

/** A front-matter template for `brief new`, with every field documented as a comment. */
export function briefTemplate(title: string, mode: Mode, provider: Provider, worker: WorkerTerms): string {
  return renderBriefTemplate(title, mode, provider, worker);
}
