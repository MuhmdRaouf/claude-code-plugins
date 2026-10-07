/**
 * The model a tool says it ran on, as the tool names it: omp and pi stamp every assistant message with their own
 * provider id and model id. It is the tool's own choice (its setup's default), reported back, never one the plugin
 * picked.
 */
export function reportedModel(message: Readonly<Record<string, unknown>>): string | undefined {
  const model = typeof message.model === "string" && message.model !== "" ? message.model : undefined;
  if (model === undefined) return undefined;
  const provider =
    typeof message.provider === "string" && message.provider !== "" ? message.provider : undefined;
  return provider === undefined || model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}
