import { readFile } from "node:fs/promises";
import type { AppError } from "../app/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";

export async function readText(path: string): Promise<Result<string, AppError>> {
  try {
    return ok(await readFile(path, "utf8"));
  } catch (error) {
    return err({
      kind: "brief_unreadable",
      path,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A brief's text; `-` reads stdin. */
export function readBrief(path: string, stdin: () => Promise<string>): Promise<Result<string, AppError>> {
  return path === "-" ? stdin().then(ok) : readText(path);
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
