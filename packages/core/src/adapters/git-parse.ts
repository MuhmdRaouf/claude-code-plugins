import type { ChangeSet } from "../domain/job.ts";

/** Single-value outputs (a sha, a path) end with exactly one newline; a path may itself end in whitespace. */
export function chompNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** Splits git's `-z` output into its NUL-terminated records. */
export function splitNul(text: string): string[] {
  const records = text.split("\0");
  if (records.at(-1) === "") records.pop();
  return records;
}

type TrackedChanges = Pick<ChangeSet, "added" | "modified" | "deleted">;

/** `git diff --name-status -z --no-renames` → added/modified/deleted, each sorted. Records alternate status, path.
 *  Without rename detection every status but A and D (M, T, U) is a modification of a path that exists on both sides. */
export function parseNameStatus(text: string): TrackedChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  let status: string | undefined;
  for (const record of splitNul(text)) {
    if (status === undefined) {
      status = record;
      continue;
    }
    const bucket = status === "A" ? added : status === "D" ? deleted : modified;
    bucket.push(record);
    status = undefined;
  }
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

interface StatusEntry {
  readonly path: string;
  /** The index differs from HEAD for this path (X column). */
  readonly staged: boolean;
}

/** `git status --porcelain=v1 -z --no-renames`: each record is `XY <path>`. */
export function parseStatus(text: string): StatusEntry[] {
  return splitNul(text).map((record) => ({
    path: record.slice(3),
    staged: !" ?".includes(record.charAt(0)),
  }));
}

/** `git ls-files -u -z` (`<mode> <object> <stage>\t<path>` per stage) → the unmerged paths, sorted, once each. */
export function unmergedPaths(text: string): string[] {
  const paths = splitNul(text).map((record) => record.slice(record.indexOf("\t") + 1));
  return [...new Set(paths)].sort();
}
