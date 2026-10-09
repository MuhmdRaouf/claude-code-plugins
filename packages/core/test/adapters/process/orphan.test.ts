import { describe, expect, it } from "vitest";
import { launchedPid } from "../../../src/adapters/process/orphan.ts";
import { err, ok } from "../../../src/domain/result.ts";

const NODE = "/usr/bin/node";
const reply = (overrides: Partial<Parameters<typeof launchedPid>[1]>) => ({
  status: 0,
  stdout: "4242",
  stderr: "",
  ...overrides,
});

describe("launchedPid (the launcher's reply → the orphan's pid)", () => {
  it("a clean exit with a decimal pid on stdout is that pid (surrounding whitespace ignored)", () => {
    expect(launchedPid(NODE, reply({}))).toEqual(ok(4242));
    expect(launchedPid(NODE, reply({ stdout: " 4242\n" }))).toEqual(ok(4242));
  });

  it("a launcher that could not run at all names the command and the cause", () => {
    expect(
      launchedPid(NODE, reply({ error: new Error("spawnSync ENOENT"), status: null, stdout: "" })),
    ).toEqual(err(`cannot start ${NODE}: spawnSync ENOENT`));
  });

  it("a failing launcher reports its stderr, or a generic line when it said nothing (killed by timeout)", () => {
    expect(launchedPid(NODE, reply({ status: 1, stdout: "", stderr: "cannot start /x\n" }))).toEqual(
      err("cannot start /x"),
    );
    expect(launchedPid(NODE, reply({ status: null, stdout: "" }))).toEqual(err(`cannot start ${NODE}`));
  });

  it("a clean exit without a usable pid is an error, never a pid that would signal the wrong group", () => {
    for (const stdout of ["", "abc", "-5", "0", "1", "12.5", "1e3", "99999999999999999999", "42 43"])
      expect(launchedPid(NODE, reply({ stdout }))).toEqual(err(`cannot start ${NODE}: no pid`));
  });
});
