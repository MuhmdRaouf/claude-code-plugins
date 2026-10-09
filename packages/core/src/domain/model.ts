/**
 * The two model tiers every provider's catalog fills: the brief's `model`, the `--flash` override and the dispatcher
 * agents name these, so one brief means the same on every worker.
 */
export type ModelTier = "main" | "flash";

/** A catalog model as people see it: the tier a brief picks, the provider's model id (trailer, usage, renderers) and
 *  the label `/model` shows once setup has added the model to it. */
export interface ModelRef {
  readonly tier: ModelTier;
  readonly id: string;
  readonly label: string;
  /** The Claude model id the `/model` entry says it `behavesAs`, so Claude Code applies that known model's window,
   *  thinking and effort defaults to an id it does not know. Optional: a provider Claude Code already knows leaves
   *  it unset. The label and the id sent in requests stay the provider's own. */
  readonly behavesAs?: string;
  /** The most output tokens the provider accepts for this model: `max_tokens` above it is answered 400 before a
   *  token is generated. Optional: the router leaves `max_tokens` as the request carried it when unset. */
  readonly maxOutputTokens?: number;
  /** The effort level setup makes this model's default in the Claude settings (`modelSettings.<id>.effortLevel`),
   *  when the user has none: `behavesAs` carries the known model's own default effort, which on this provider
   *  thinks too little. Optional: setup leaves the effort settings alone when unset. */
  readonly defaultEffort?: "high" | "xhigh";
  /** True when the provider takes this model's requests as text only and refuses image blocks. Optional: unset
   *  means images are accepted. */
  readonly textOnly?: boolean;
}
