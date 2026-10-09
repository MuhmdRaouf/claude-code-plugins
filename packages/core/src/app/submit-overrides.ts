import { isMap, parseDocument } from "yaml";
import { splitFrontMatter } from "../domain/brief-front-matter.ts";
import type { Engine } from "../domain/engine.ts";
import type { ModelTier } from "../domain/model.ts";
import type { Provider } from "../domain/provider.ts";

export interface BriefOverrides {
  readonly model?: ModelTier;
  readonly mode?: "edit" | "exec" | "readonly";
  /** `run --engine`: wins over the brief's `engine:` and the configured default. */
  readonly engine?: Engine;
}

/** The brief text with CLI overrides written into its front matter, so parseBrief derives the mode-dependent defaults
 *  (model, scope, report) from the overridden values. A document that does not parse is returned unchanged for
 *  parseBrief to report. A tier is written under the name the provider's briefs use for it. */
export function withOverrides(text: string, overrides: BriefOverrides, provider: Provider): string {
  const effective = {
    ...overrides,
    ...(overrides.model === undefined ? {} : { model: provider.tierNames[overrides.model] }),
  };
  const entries = Object.entries(effective).filter(([, value]) => value !== undefined);
  const document = splitFrontMatter(text);
  if (entries.length === 0 || document === null) return text;
  const yaml = parseDocument(document.frontMatter);
  if (yaml.errors.length > 0 || !isMap(yaml.contents)) return text;
  for (const [key, value] of entries) yaml.set(key, value);
  return `---\n${yaml.toString()}---\n${document.body}`;
}
