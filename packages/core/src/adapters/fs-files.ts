// The one way a state file is written, and the one way a JSON file is read. A write goes to a temp file beside the
// target, created with the target's mode, fsynced and renamed over it, then the directory is fsynced: a reader sees the
// old file or the new one, never a torn one, and a crash after the rename does not lose it. Every caller serialises
// writers of the same path itself (the temp name is per process).
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";
import { parseJson } from "../domain/json.ts";

/** A file's permission bits; `"preserve"` keeps the target's own (0600 when it does not exist yet). */
export type FileMode = number | "preserve";

export interface WriteOptions {
  /** Default 0600: state files are private. */
  readonly mode?: FileMode;
  /** Create the parent directory (0700) when it is missing. */
  readonly mkdir?: boolean;
  /** Checked between the fsync and the rename: false leaves the target as it is and the write reports false (a
   *  compare-and-swap for a file someone else may have changed meanwhile). */
  readonly commitIf?: () => boolean;
}

const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

function modeSync(path: string, mode: FileMode | undefined): number {
  if (mode !== "preserve") return mode ?? PRIVATE_FILE;
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return PRIVATE_FILE;
  }
}

/** Writes `data` atomically (see the module comment); false only when `commitIf` said no. */
export function writeFileAtomicSync(
  path: string,
  data: string | Uint8Array,
  options: WriteOptions = {},
): boolean {
  const mode = modeSync(path, options.mode);
  if (options.mkdir) mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    if (typeof data === "string") writeSync(fd, data);
    else writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // The umask may have narrowed the mode the file was created with.
  chmodSync(tmp, mode);
  if (options.commitIf !== undefined && !options.commitIf()) {
    rmSync(tmp, { force: true });
    return false;
  }
  renameSync(tmp, path);
  syncDirectorySync(dirname(path));
  return true;
}

/** The asynchronous writeFileAtomicSync, for callers on the event loop (the job store, the limiter, the registry). */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: Omit<WriteOptions, "commitIf"> = {},
): Promise<void> {
  const mode =
    options.mode === "preserve"
      ? await stat(path).then(
          (s) => s.mode & 0o777,
          () => PRIVATE_FILE,
        )
      : (options.mode ?? PRIVATE_FILE);
  if (options.mkdir) await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR });
  const tmp = `${path}.${process.pid}.tmp`;
  const handle = await open(tmp, "w", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  await syncDirectory(dirname(path));
}

/** The file's JSON when it exists, parses and matches `schema`; undefined for anything else. */
export function readJsonFile<T>(path: string, schema: z.ZodType<T>): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return parseJson(text, schema);
}

/** The asynchronous readJsonFile. */
export async function readJsonFileAsync<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseJson(text, schema);
}

/** Persists the rename itself (the directory entry); best effort where directories cannot be fsynced. */
async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } catch {
    // Not supported on this platform or filesystem: the rename is still atomic, just not yet durable.
  } finally {
    await handle.close();
  }
}

function syncDirectorySync(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // As above.
  } finally {
    closeSync(fd);
  }
}
