import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

/** What a path holds right now, so that a second edit to an already-dirty file changes the fingerprint even though its
 *  porcelain status line does not. */
async function contentDigest(file: string): Promise<string> {
  try {
    const stats = await lstat(file);
    if (stats.isSymbolicLink()) return `link:${await readlink(file)}`;
    return `file:${stats.mode.toString(8)}:${createHash("sha256")
      .update(await readFile(file))
      .digest("hex")}`;
  } catch {
    return "unreadable";
  }
}

/** sha256 over the HEAD state, the porcelain status and the content of every path the status lists. */
export async function fingerprint(
  dir: string,
  head: string,
  status: string,
  paths: readonly string[],
): Promise<string> {
  const hash = createHash("sha256").update(head).update("\0\0").update(status);
  const digests = await Promise.all(paths.map((path) => contentDigest(join(dir, path))));
  paths.forEach((path, i) => {
    hash.update(`\0${path}\0${digests[i]}`);
  });
  return hash.digest("hex");
}
