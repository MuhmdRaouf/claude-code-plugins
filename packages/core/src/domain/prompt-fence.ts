/**
 * A markdown fenced block around arbitrary text. The fence is one backtick longer than the longest backtick run inside,
 * so quoted output can never close it early.
 */
export function fenced(content: string, info: string): string {
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const body = content.endsWith("\n") ? content : `${content}\n`;
  return `${fence}${info}\n${body}${fence}`;
}
