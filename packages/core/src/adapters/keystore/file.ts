// The key file (`NAME=<key>` lines, mode 0600, directory 0700): read by every key lookup, and the store setup writes
// only where the platform has no secret store. A file other users can read is refused, whatever it holds.
import { type FileHandle, mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Provider } from "../../domain/provider.ts";
import { err, ok, type Result } from "../../domain/result.ts";
import type { WorkerError } from "../../ports/index.ts";
import type { KeyStore } from "../../ports/keys.ts";
import { errnoCode } from "../fs-errors.ts";
import { writeFileAtomic } from "../fs-files.ts";
import { assertValidKey } from "./port.ts";

/** The key-file slice of a provider: its display name and the env names a key line may use. */
type KeyFileProvider = Pick<Provider, "display" | "keyEnv">;

const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

export function expandHome(path: string, home: string = homedir()): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;
}

/** Line `NAME=<key>` (optional `export`, optional quotes) for any of the provider's key env names. */
function keyLine(names: readonly string[]): RegExp {
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`^(?:export\\s+)?(?:${alternatives})\\s*=\\s*(.*)$`);
}

function lineValue(raw: string, line: RegExp): string | undefined {
  const match = line.exec(raw.trim());
  return match?.[1] === undefined ? undefined : unquote(match[1].trim());
}

function unquote(value: string): string {
  const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
  return quoted ? value.slice(1, -1) : value;
}

/** The key in `file`: ok(undefined) when there is no file or no key line; an error when the file is looser than 0600
 *  or cannot be read. One descriptor serves the mode check and the read, so the file cannot be swapped in between. */
export async function readKeyFile(
  provider: KeyFileProvider,
  file: string,
): Promise<Result<string | undefined, WorkerError>> {
  let handle: FileHandle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    return readFailure(provider, file, error);
  }
  try {
    const { mode } = await handle.stat();
    if ((mode & 0o077) !== 0)
      return err({
        kind: "insecure_key_file",
        label: `${provider.display} key file`,
        path: file,
        mode: formatMode(mode),
      });
    const line = keyLine(provider.keyEnv);
    for (const raw of (await handle.readFile("utf8")).split("\n")) {
      const value = lineValue(raw, line);
      if (value !== undefined) return ok(value);
    }
    return ok(undefined);
  } catch (error) {
    return readFailure(provider, file, error);
  } finally {
    await handle.close();
  }
}

function readFailure(
  provider: KeyFileProvider,
  file: string,
  error: unknown,
): Result<string | undefined, WorkerError> {
  const code = errnoCode(error);
  if (code === "ENOENT") return ok(undefined);
  return err({
    kind: "no_key",
    message: `cannot read ${provider.display} key file ${file} (${code ?? "unknown error"})`,
  });
}

function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

async function readText(file: string): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Writes `text` as a 0600 file in a 0700 directory, atomically. */
async function writePrivate(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: PRIVATE_DIR });
  await writeFileAtomic(file, text, { mode: PRIVATE_FILE });
}

/**
 * Removes the provider's key lines from `file` (only those holding `value`, when given), keeping every other line.
 * The file goes away when nothing but blank lines would remain. Returns whether a line was removed.
 */
export async function removeKeyLine(
  provider: KeyFileProvider,
  file: string,
  value?: string,
): Promise<boolean> {
  const text = await readText(file);
  if (text === undefined) return false;
  const line = keyLine(provider.keyEnv);
  const lines = text.split("\n");
  const kept = lines.filter((raw) => {
    const found = lineValue(raw, line);
    return found === undefined || (value !== undefined && found !== value);
  });
  if (kept.length === lines.length) return false;
  if (kept.every((raw) => raw.trim() === "")) await unlink(file);
  else await writePrivate(file, kept.join("\n"));
  return true;
}

/** The key file as a KeyStore: always available, the first key env name as the line it writes. */
export function fileKeyStore(provider: KeyFileProvider, file: string): KeyStore {
  const name = provider.keyEnv[0] ?? "API_KEY";
  return {
    kind: "file",
    label: file,
    async available() {
      return true;
    },
    async get() {
      const read = await readKeyFile(provider, file);
      return read.ok ? read.value || undefined : undefined;
    },
    async set(key) {
      assertValidKey(key);
      const line = keyLine(provider.keyEnv);
      const others = ((await readText(file)) ?? "").split("\n").filter((raw) => !line.test(raw.trim()));
      while (others.at(-1) === "") others.pop();
      await writePrivate(file, `${[...others, `${name}=${key}`].join("\n")}\n`);
    },
    async remove() {
      await removeKeyLine(provider, file);
    },
  };
}
