import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AppError } from "../../app/errors.ts";
import { validBrief } from "../../app/submit.ts";
import { type Brief, briefTemplate } from "../../domain/brief.ts";
import { splitFrontMatter } from "../../domain/brief-front-matter.ts";
import { plural } from "../../render/format.ts";
import type { Command, Invocation } from "../command.ts";
import { describeBriefError, describeError } from "../errors.ts";
import { EXIT, type ExitCode } from "../exit.ts";
import { readText } from "../read.ts";
import { modeOption } from "./mode.ts";

const SLUG_MAX = 60;

export const briefCommand: Command = {
  name: "brief",
  synopsis: ["brief new <title> [--mode edit|exec|readonly]", "brief lint <path>"],
  options: { mode: { type: "string" } },
  async run(call) {
    const [action, ...rest] = call.positionals;
    if (action === "new") return newBrief(call, rest.join(" ").trim());
    if (action === "lint" && rest[0] !== undefined) return lint(call, rest[0]);
    return call.usage(action === "lint" ? "brief lint needs a path" : "brief needs new or lint");
  },
};

/** Writes the template to <state>/briefs/<slug>.md (-2, -3… when taken) and prints only its path. */
async function newBrief(call: Invocation, title: string): Promise<ExitCode> {
  if (title === "") return call.usage("brief new needs a title");
  const mode = modeOption(call);
  if (!mode.ok) return call.usage(mode.error);
  const dir = join(call.deps.host.stateRoot, "briefs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const text = briefTemplate(title, mode.value ?? "edit", call.deps.provider, call.deps.worker.caps);
  for (let n = 1; ; n += 1) {
    const path = join(dir, `${slug(title)}${n === 1 ? "" : `-${n}`}.md`);
    if (await created(path, text)) {
      call.deps.out.line(path);
      return EXIT.ok;
    }
  }
}

async function created(path: string, text: string): Promise<boolean> {
  try {
    await writeFile(path, text, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

function slug(title: string): string {
  const text = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, "");
  return text === "" ? "brief" : text;
}

/** Exactly what `run` would check, plus the untouched template's placeholder body. One problem per line on stdout. */
async function lint(call: Invocation, path: string): Promise<ExitCode> {
  const absolute = resolve(call.cwd, path);
  const text = await readText(absolute);
  if (!text.ok) return call.fail(text.error);
  const brief = await validBrief(call.deps, { text: text.value, sourcePath: absolute, cwd: call.cwd });
  const problems = brief.ok ? placeholder(call, text.value) : problemsOf(call, brief.error);
  for (const problem of problems) call.deps.out.line(`${path}: ${problem}`);
  if (problems.length > 0 || !brief.ok) return EXIT.usage;
  call.deps.out.line(okLine(call, brief.value));
  return EXIT.ok;
}

function problemsOf(call: Invocation, error: AppError): readonly string[] {
  return error.kind === "brief"
    ? error.errors.map(describeBriefError)
    : [describeError(call.deps.provider, error)];
}

function placeholder(call: Invocation, text: string): readonly string[] {
  const template = splitFrontMatter(
    briefTemplate("", "edit", call.deps.provider, call.deps.worker.caps),
  )?.body.trim();
  return splitFrontMatter(text)?.body.trim() === template ? ["the body still has the TODO placeholder"] : [];
}

function okLine(call: Invocation, brief: Brief): string {
  return `ok: ${brief.title} (${call.deps.provider.catalog[brief.model].id}, ${brief.mode}, ${plural(brief.gates.length, "gate")})`;
}
