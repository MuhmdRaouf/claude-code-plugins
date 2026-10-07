import type { Runner, RunResult } from "../../src/adapters/keystore/index.ts";
import type { KeyStore } from "../../src/ports/keys.ts";

/** A key no real provider issues; tests grep their own output for it. */
export const TEST_KEY = "zt-SECRET.key_0123456789abcdef";

export interface RunCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly stdin: string | undefined;
}

/** A runner that records every call and answers through `answer` (default: exit 0, no output). */
export class FakeRunner {
  readonly calls: RunCall[] = [];
  answer: (call: RunCall) => RunResult | Promise<RunResult> = () => ({ code: 0, stdout: "", stderr: "" });
  readonly run: Runner = async (cmd, args, stdin) => {
    const call = { cmd, args: [...args], stdin };
    this.calls.push(call);
    return this.answer(call);
  };
  /** Every argv element of every call, the command included. */
  get argv(): string[] {
    return this.calls.flatMap((call) => [call.cmd, ...call.args]);
  }
}

/** An in-memory store: what a fake page fills and setup polls. */
export class MemoryKeyStore implements KeyStore {
  value: string | undefined;
  sets = 0;
  removes = 0;
  failSet = false;
  readonly kind: KeyStore["kind"];
  readonly label: string;
  constructor(kind: KeyStore["kind"] = "macos", label = "macOS Keychain", value?: string) {
    this.kind = kind;
    this.label = label;
    this.value = value;
  }
  async available(): Promise<boolean> {
    return true;
  }
  async get(): Promise<string | undefined> {
    return this.value;
  }
  async set(key: string): Promise<void> {
    if (this.failSet) throw new Error(`could not store the key in ${this.label} (exit 1)`);
    this.sets += 1;
    this.value = key;
  }
  async remove(): Promise<void> {
    this.removes += 1;
    this.value = undefined;
  }
}
