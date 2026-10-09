// Which JavaScript runtime this process runs on. Bun is the default (the launcher prefers it when it is on PATH), Node
// the fallback; every spawn of our own code reuses process.execPath, so a bun-started router forks bun workers.

/** `bun 1.3.14 (/usr/local/bin/bun)` or `node 24.11.0 (/usr/bin/node)`: what setup reports on its runtime line. */
export function runtimeLabel(
  versions: Readonly<Record<string, string | undefined>> = process.versions,
  execPath: string = process.execPath,
): string {
  const bun = versions.bun;
  return bun === undefined ? `node ${versions.node ?? "?"} (${execPath})` : `bun ${bun} (${execPath})`;
}
