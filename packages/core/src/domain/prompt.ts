import type { Brief } from "./brief.ts";
import type { Attempt } from "./job.ts";
import { failureSections } from "./prompt-failures.ts";
import { fenced } from "./prompt-fence.ts";
import { contractFooter } from "./prompt-footer.ts";
import { attemptSummary } from "./prompt-summary.ts";
import { lines, paragraphs } from "./prompt-text.ts";
import type { Provider } from "./provider.ts";

export interface PromptLimits {
  /** Max characters of one gate tail quoted back to the worker. */
  readonly gateTailChars: number;
  /** Max number of out-of-scope paths listed. */
  readonly pathsListed: number;
}

export const DEFAULT_LIMITS: PromptLimits = { gateTailChars: 4000, pathsListed: 50 };

const STILL_BOUND =
  "The contract from your first message still applies. End your run with the structured report.";

/**
 * First prompt: brief body + the contract footer. The footer states the mode's workspace rules, scope and forbid globs,
 * the exact gates the plugin will run, "do not commit", "never print secrets", the artifacts dir for exec mode, and that
 * the run must end with the structured report.
 */
export function initialPrompt(brief: Brief, artifactsDir: string, provider: Provider): string {
  return `${withNewline(brief.body)}\n${contractFooter(brief, artifactsDir, provider)}`;
}

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Follow-up prompt for a resumed session after a failed verdict: names the verdict, quotes each failing gate (command,
 * exit code or timeout, bounded tail), lists out-of-scope/forbidden paths, and asks for the smallest change that fixes
 * exactly that, keeping the rest. Never repeats the brief (the session has it).
 */
export function autoFixPrompt(_brief: Brief, failed: Attempt, limits: PromptLimits = DEFAULT_LIMITS): string {
  return paragraphs([
    `Verification failed: ${failed.verdict ?? "no verdict"}.`,
    ...failureSections(failed, limits),
    lines([
      "Make the smallest change that fixes exactly these failures. Keep everything else as it is.",
      STILL_BOUND,
    ]),
  ]);
}

/** Follow-up prompt carrying the reviewer's feedback verbatim plus the last verification summary. */
export function reviewFixPrompt(
  _brief: Brief,
  last: Attempt,
  feedback: string,
  limits: PromptLimits = DEFAULT_LIMITS,
): string {
  return paragraphs([
    "The reviewer returned your work with this feedback:",
    fenced(feedback, "text"),
    `Last attempt ${attemptSummary(last)}`,
    ...failureSections(last, limits),
    lines([
      "Address the feedback with the smallest change that satisfies it. Keep everything else as it is.",
      STILL_BOUND,
    ]),
  ]);
}

/**
 * When the previous session cannot be resumed: brief + the history condensed (each attempt's verdict and failures) + the
 * new instruction, so the fresh session is self-contained. `artifactsDir` is named in the footer, as in initialPrompt.
 */
export function selfContainedPrompt(
  brief: Brief,
  history: readonly Attempt[],
  instruction: string,
  artifactsDir: string,
  provider: Provider,
): string {
  return paragraphs([
    brief.body,
    ...historySection(history),
    lines(["## Now", "", instruction]),
    contractFooter(brief, artifactsDir, provider),
  ]);
}

function historySection(history: readonly Attempt[]): readonly string[] {
  if (history.length === 0) return [];
  return [
    lines([
      "## Earlier attempts",
      "",
      "This task was attempted before in another session. Results:",
      ...history.map((attempt) => `- ${attemptSummary(attempt)}`),
    ]),
  ];
}
