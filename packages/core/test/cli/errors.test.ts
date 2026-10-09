import { describe, expect, it } from "vitest";
import type { AppError } from "../../src/app/errors.ts";
import { describeError, exitFor } from "../../src/cli/errors.ts";
import { EXIT } from "../../src/cli/exit.ts";
import { ACME_PROVIDER, REFERENCE_PROVIDER } from "../support/provider.ts";

const CASES: readonly (readonly [AppError, string, number])[] = [
  [
    { kind: "brief", errors: [{ kind: "yaml", message: "bad indent" }] },
    "invalid brief: YAML: bad indent",
    EXIT.usage,
  ],
  [{ kind: "brief_unreadable", path: "/b.md", message: "EACCES" }, "cannot read /b.md: EACCES", EXIT.usage],
  [
    { kind: "missing_env", names: ["TOKEN", "URL"] },
    "the brief's env names are not set in this environment: TOKEN, URL",
    EXIT.usage,
  ],
  [
    { kind: "wrong_state", id: "j1", state: "queued", allowed: ["awaiting_review"] },
    "job j1 is queued; this only works on a job that awaits review",
    EXIT.usage,
  ],
  [
    { kind: "lifecycle", error: { kind: "illegal_transition", from: "accepted", event: "returned" } },
    "the job was already accepted, so it cannot be returned",
    EXIT.unexpected,
  ],
  [{ kind: "git", error: { kind: "not_a_repo", path: "/x" } }, "not a git repository: /x", EXIT.unexpected],
  [{ kind: "git", error: { kind: "bad_ref", ref: "nope" } }, "unknown git ref: nope", EXIT.unexpected],
  [
    { kind: "git", error: { kind: "dirty", paths: ["a", "b"] } },
    "uncommitted changes in the way: a, b",
    EXIT.conflict,
  ],
  [
    { kind: "store", error: { kind: "locked", id: "j1", holderPid: 42 } },
    "job j1 is held by the driver with pid 42",
    EXIT.unexpected,
  ],
  [
    { kind: "store", error: { kind: "version_conflict", id: "j1", expected: 1, actual: 2 } },
    "job j1 changed meanwhile; run the command again",
    EXIT.unexpected,
  ],
  [{ kind: "store", error: { kind: "io", message: "EIO" } }, "state store: EIO", EXIT.unexpected],
  [
    {
      kind: "worker",
      error: { kind: "insecure_key_file", label: "Z.ai key file", path: "/k", mode: "0644" },
    },
    "Z.ai key file /k has mode 0644: run chmod 600 on it",
    EXIT.unexpected,
  ],
  [
    { kind: "worker", error: { kind: "spawn_failed", message: "ENOENT" } },
    "cannot start claude: ENOENT",
    EXIT.unexpected,
  ],
  [
    { kind: "worker", error: { kind: "protocol", message: "no ready frame within 45s" } },
    "claude does not speak the expected protocol: no ready frame within 45s",
    EXIT.unexpected,
  ],
  [
    { kind: "worker", error: { kind: "unsupported", message: "effort medium" } },
    "claude cannot do this: effort medium",
    EXIT.unexpected,
  ],
  [{ kind: "empty_feedback" }, "the feedback must not be empty", EXIT.usage],
  [
    { kind: "not_pass", id: "j1", verdict: null },
    "job j1 has verdict none, not pass: accept --force to accept it anyway",
    EXIT.notPass,
  ],
];

describe("describeError / exitFor", () => {
  it.each(CASES)("%o → its one line and exit code", (error, line, code) => {
    expect(describeError(REFERENCE_PROVIDER, error)).toBe(line);
    expect(exitFor(error)).toBe(code);
  });

  it("renders worker errors in the provider's own names: the key-file label and the worker name come from outside", () => {
    const insecure = describeError(ACME_PROVIDER, {
      kind: "worker",
      error: { kind: "insecure_key_file", label: "acme key file", path: "/k", mode: "0644" },
    });
    const spawn = describeError(ACME_PROVIDER, {
      kind: "worker",
      error: { kind: "spawn_failed", message: "ENOENT" },
    });

    expect(insecure).toBe("acme key file /k has mode 0644: run chmod 600 on it");
    expect(spawn).toBe("cannot start acmebot: ENOENT");
  });
});
