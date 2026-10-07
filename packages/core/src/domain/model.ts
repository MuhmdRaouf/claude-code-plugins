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
}
