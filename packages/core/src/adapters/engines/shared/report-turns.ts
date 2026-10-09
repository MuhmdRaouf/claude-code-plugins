// The RPC engines' turns for one run: the prompt with the report contract, then up to MAX_REPORT_CORRECTIONS more
// turns while the report does not check (domain/report-capture.ts).
import {
  correctionPrompt,
  extractReport,
  MAX_REPORT_CORRECTIONS,
  reportInstructions,
} from "../../../domain/report-capture.ts";
import type { WorkerSpec } from "../../../ports/index.ts";

/** One prompt's turn as the engine's client reports it. */
export interface Turn {
  readonly promptSentAt: number;
  readonly endedAt: number;
}

export interface ReportTurns<T extends Turn> {
  /** The first turn's start to the last one's end. */
  readonly startedAt: number;
  readonly endedAt: number;
  /** The last turn. */
  readonly last: T;
  /** The accepted report, or the last extracted value (null when nothing parsed) for the core to check itself. */
  readonly value: unknown;
}

export interface TurnDriver<T extends Turn> {
  /** Sends one prompt and waits for its turn to end; undefined when the turn failed (the exit tells the story). */
  prompt(text: string): Promise<T | undefined>;
  /** The final assistant text so far. */
  finalText(): string;
  /** True when the turn ended in a way no correction can fix (the engine's own failure). */
  failed(turn: T): boolean;
}

export async function runReportTurns<T extends Turn>(
  driver: TurnDriver<T>,
  spec: Pick<WorkerSpec, "prompt" | "report">,
): Promise<ReportTurns<T> | undefined> {
  const first = await driver.prompt(reportInstructions(spec.prompt, spec.report.jsonSchema));
  if (first === undefined) return undefined;
  let turns: ReportTurns<T> = {
    startedAt: first.promptSentAt,
    endedAt: first.endedAt,
    last: first,
    value: extractReport(driver.finalText()),
  };
  for (let correction = 0; correction < MAX_REPORT_CORRECTIONS; correction += 1) {
    if (driver.failed(turns.last)) return turns;
    const check = spec.report.validate(turns.value);
    if (check.valid) return turns;
    const again = await driver.prompt(correctionPrompt(check.problems));
    if (again === undefined) return undefined;
    turns = { ...turns, endedAt: again.endedAt, last: again, value: extractReport(driver.finalText()) };
  }
  return turns;
}
