/** A process id read from a pid or lock file: digits only, and never 0 or 1 (0 would signal our own group, 1 is init,
 *  which no lock of ours is ever held by). */
export function parsePid(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}
