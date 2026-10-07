/** Paragraphs separated by one blank line, ending in exactly one newline. */
export function paragraphs(parts: readonly string[]): string {
  return `${parts.map((part) => part.replace(/\n+$/, "")).join("\n\n")}\n`;
}

/** Lines joined with a trailing newline. */
export function lines(content: readonly string[]): string {
  return `${content.join("\n")}\n`;
}
