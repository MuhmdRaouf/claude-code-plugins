import { glob, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type BatchItem, batch } from "../../app/batch.ts";
import type { AppError } from "../../app/errors.ts";
import type { Job } from "../../domain/job.ts";
import type { Command, Invocation } from "../command.ts";
import { describeError } from "../errors.ts";
import { EXIT } from "../exit.ts";
import { readText } from "../read.ts";
import { followAll } from "./wait.ts";

interface Rejected {
  readonly path: string;
  readonly error: AppError;
}

export const batchCommand: Command = {
  name: "batch",
  synopsis: ["batch <dir|glob|manifest.txt> [--wait] [--json]"],
  options: { wait: { type: "boolean" } },
  async run(call) {
    if (call.flag("wait") && call.flag("json")) return call.usage("--wait and --json exclude each other");
    const [target] = call.positionals;
    if (target === undefined) return call.usage("batch needs a directory, a glob or a manifest file");
    const paths = await briefPaths(call.cwd, target);
    if (paths.length === 0) {
      call.deps.out.error(`${call.deps.provider.name}: no briefs found for ${target}`);
      return EXIT.usage;
    }
    const { items, unreadable } = await readBriefs(paths);
    const outcome = await batch(call.deps, items, call.cwd);
    const rejected = [...unreadable, ...outcome.rejected];
    const pairs = pairUp(items, outcome.submitted, outcome.rejected);
    report(call, pairs, rejected);
    if (call.flag("wait") && pairs.length > 0) {
      const followed = await followAll(
        call,
        pairs.map(([, job]) => job.id),
      );
      return followed === EXIT.ok && rejected.length > 0 ? EXIT.usage : followed;
    }
    return rejected.length === 0 ? EXIT.ok : EXIT.usage;
  },
};

/** Every brief that reads, and the ones that do not as rejections. */
async function readBriefs(
  paths: readonly string[],
): Promise<{ readonly items: BatchItem[]; readonly unreadable: Rejected[] }> {
  const items: BatchItem[] = [];
  const unreadable: Rejected[] = [];
  for (const path of paths) {
    const text = await readText(path);
    if (text.ok) items.push({ path, text: text.value });
    else unreadable.push({ path, error: text.error });
  }
  return { items, unreadable };
}

function report(
  call: Invocation,
  submitted: readonly (readonly [string, Job])[],
  rejected: readonly Rejected[],
): void {
  if (call.flag("json")) {
    call.json({
      submitted: submitted.map(([, job]) => job),
      rejected: rejected.map(({ path, error }) => ({
        path,
        error: describeError(call.deps.provider, error),
      })),
    });
    return;
  }
  for (const [path, job] of submitted)
    call.deps.out.line(`submitted ${job.id}: ${job.brief.title} (${path})`);
  for (const { path, error } of rejected)
    call.deps.out.error(
      `${call.deps.provider.name}: rejected ${path}: ${describeError(call.deps.provider, error)}`,
    );
}

/** batch keeps the items' order in both lists, so walking them together gives each submitted job its path. */
function pairUp(
  items: readonly BatchItem[],
  submitted: readonly Job[],
  rejected: readonly Rejected[],
): (readonly [string, Job])[] {
  const pairs: (readonly [string, Job])[] = [];
  let next = 0;
  let skipped = 0;
  for (const item of items) {
    const job = submitted[next];
    if (rejected[skipped]?.path === item.path) skipped += 1;
    else if (job !== undefined) {
      pairs.push([item.path, job]);
      next += 1;
    }
  }
  return pairs;
}

/** A directory gives its *.md files; a .txt file is a manifest (one path per line, relative to it, # comments); any
 *  other file is one brief; anything else is a glob relative to cwd. */
async function briefPaths(cwd: string, target: string): Promise<readonly string[]> {
  const path = resolve(cwd, target);
  const kind = await stat(path).catch(() => undefined);
  if (kind?.isDirectory()) {
    const names = await readdir(path);
    return names
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => join(path, name));
  }
  if (kind?.isFile()) return path.endsWith(".txt") ? manifest(path) : [path];
  const matches: string[] = [];
  for await (const match of glob(target, { cwd })) matches.push(isAbsolute(match) ? match : join(cwd, match));
  return matches.sort();
}

async function manifest(path: string): Promise<readonly string[]> {
  const text = await readText(path);
  if (!text.ok) return [];
  return text.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => resolve(dirname(path), line));
}
