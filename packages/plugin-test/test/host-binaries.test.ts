/**
 * The host-binary freshness check: a binary older than any Go input (a .go file, go.mod, go.sum or VERSION) is
 * stale, so the shared suites rebuild it instead of testing a binary built before the change.
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { hostBinaryStale } from "../support/core-parity.ts";
import { tempDir } from "../support/tmp.ts";

const BINARY = "plugin-core-host";
const INPUTS = ["router.go", "go.mod", "go.sum", "VERSION"] as const;

const BUILT = new Date("2026-10-14T16:35:00Z");
const NEWER = new Date("2026-10-14T16:36:00Z");
const OLDER = new Date("2026-10-14T16:34:00Z");

function writeAt(dir: string, name: string, at: Date): void {
  const path = join(dir, name);
  writeFileSync(path, "");
  utimesSync(path, at, at);
}

/** A temp tree where every input carries its own mtime; the binary starts at BUILT. */
function tree(mtimes: Readonly<Record<string, Date>>): string {
  const dir = tempDir("hostbin-");
  mkdirSync(dir, { recursive: true });
  writeAt(dir, BINARY, BUILT);
  for (const [name, at] of Object.entries(mtimes)) writeAt(dir, name, at);
  return dir;
}

describe("hostBinaryStale", () => {
  for (const input of INPUTS) {
    it(`is stale when ${input} is newer than the binary`, () => {
      const dir = tree({ [input]: NEWER });
      expect(
        hostBinaryStale(
          join(dir, BINARY),
          INPUTS.map((name) => join(dir, name)),
        ),
      ).toBe(true);
    });
  }

  it("is fresh when the binary is newer than every input", () => {
    const dir = tree(Object.fromEntries(INPUTS.map((name) => [name, OLDER])));
    expect(
      hostBinaryStale(
        join(dir, BINARY),
        INPUTS.map((name) => join(dir, name)),
      ),
    ).toBe(false);
  });

  it("is stale when the binary is missing", () => {
    const dir = tree({});
    expect(
      hostBinaryStale(
        join(dir, "never-built"),
        INPUTS.map((name) => join(dir, name)),
      ),
    ).toBe(true);
  });
});
