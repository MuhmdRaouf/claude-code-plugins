import { type AppError, describeGitError, describeWorkerError } from "../app/errors.ts";
import type { BriefError } from "../domain/brief.ts";
import type { Provider } from "../domain/provider.ts";
import type { StoreError } from "../ports/index.ts";
import { EXIT, type ExitCode } from "./exit.ts";

export function describeBriefError(error: BriefError): string {
  switch (error.kind) {
    case "no_front_matter":
      return "no YAML front matter (start the file with ---)";
    case "yaml":
      return `YAML: ${error.message}`;
    case "field":
      return `${error.field}: ${error.message}`;
    case "empty_body":
      return "the body (the task) is empty";
  }
}

function describeStoreError({ name, slash }: Provider, error: StoreError): string {
  switch (error.kind) {
    case "not_found":
      return `no ${name} job matches "${error.id}" (${slash}board lists them)`;
    case "locked":
      return `job ${error.id} is held by the driver with pid ${error.holderPid}`;
    case "version_conflict":
      return `job ${error.id} changed meanwhile; run the command again`;
    case "io":
      return `state store: ${error.message}`;
  }
}

/** One line, no prefix. */
export function describeError(provider: Provider, error: AppError): string {
  switch (error.kind) {
    case "brief":
      return `invalid brief: ${error.errors.map(describeBriefError).join("; ")}`;
    case "brief_unreadable":
      return `cannot read ${error.path}: ${error.message}`;
    case "missing_env":
      return `the brief's env names are not set in this environment: ${error.names.join(", ")}`;
    case "wrong_state":
      return `job ${error.id} ${stateWords(error.state)}; this only works on a job that ${orList(error.allowed.map(stateNoun))}`;
    case "lifecycle":
      return `the job ${stateWords(error.error.from)}, so it cannot be ${eventWords(error.error.event)}`;
    case "git":
      return describeGitError(error.error);
    case "store":
      return describeStoreError(provider, error.error);
    case "worker":
      return describeWorkerError(provider, error.error);
    case "empty_feedback":
      return "the feedback must not be empty";
    case "not_pass":
      return `job ${error.id} has verdict ${error.verdict ?? "none"}, not pass: accept --force to accept it anyway`;
    case "land_conflict":
      return `conflict in ${error.paths.join(", ")}`;
    case "land_verify_failed":
      return `verification in a fresh checkout failed: ${error.command}`;
    case "engine_not_enabled":
      return `the ${error.engine} engine is not enabled: run ${provider.slash}setup:${error.engine} first`;
  }
}

function orList(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

export function exitFor(error: AppError): ExitCode {
  switch (error.kind) {
    case "store":
      return error.error.kind === "not_found" ? EXIT.notFound : EXIT.unexpected;
    case "git":
      return error.error.kind === "conflict" || error.error.kind === "dirty"
        ? EXIT.conflict
        : EXIT.unexpected;
    case "land_conflict":
    case "land_verify_failed":
      return EXIT.conflict;
    case "not_pass":
      return EXIT.notPass;
    case "engine_not_enabled":
      return EXIT.notReady;
    case "brief":
    case "brief_unreadable":
    case "missing_env":
    case "empty_feedback":
    case "wrong_state":
      return EXIT.usage;
    case "lifecycle":
    case "worker":
      return EXIT.unexpected;
  }
}

/** Each job state in words: "job X <words>". */
const STATE_WORDS: Readonly<Record<string, string>> = {
  queued: "is queued",
  running: "is running",
  verifying: "is being verified",
  awaiting_review: "awaits review",
  accepted: "was already accepted",
  discarded: "was already discarded",
};

function stateWords(state: string): string {
  return STATE_WORDS[state] ?? `is ${state.replace("_", " ")}`;
}

/** "a job that <noun>": the same table without "was already". */
function stateNoun(state: string): string {
  return stateWords(state).replace("was already ", "was ");
}

/** What each lifecycle event does to a job, as "cannot be <words>". */
const EVENT_WORDS: Readonly<Record<string, string>> = {
  slot_acquired: "started",
  worker_exited: "finished",
  verified: "verified",
  retry: "retried",
  returned: "returned",
  accepted: "accepted",
  discarded: "discarded",
  stopped: "stopped",
};

function eventWords(event: string): string {
  return EVENT_WORDS[event] ?? event.replace("_", " ");
}
