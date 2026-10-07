// What the platform key stores share: the runner they call their tools through, the key's names in a store, the key's
// accepted shape and the failure text. A key only ever travels on a tool's stdin: never in argv, never in an error
// message.

/** What a platform tool returned. `missing` means the tool itself could not be started (ENOENT and the like). */
export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly missing?: boolean;
}

/** Runs one tool without a shell; `stdin`, when given, is written and closed. Tests pass a fake. */
export type Runner = (cmd: string, args: readonly string[], stdin?: string) => Promise<RunResult>;

/** The store's names for one provider: service `<name>-plugin-cc`, account `api-key`. */
export interface KeyIdentity {
  readonly service: string;
  readonly account: string;
  /** The provider as people know it, for the Secret Service label. */
  readonly display: string;
}

const KEY_ACCOUNT = "api-key";

export function keyIdentity(provider: { readonly name: string; readonly display: string }): KeyIdentity {
  const service = `${provider.name}-plugin-cc`;
  // The service name is quoted into a `security -i` command line: it must stay plain.
  if (!/^[a-z0-9-]+$/.test(service))
    throw new Error(`unsupported key service name ${JSON.stringify(service)}`);
  return { service, account: KEY_ACCOUNT, display: provider.display };
}

const KEY_SHAPE = /^[A-Za-z0-9._-]{16,512}$/;

/** A provider key as the stores accept it: 16-512 characters of `[A-Za-z0-9._-]`. This also keeps quoting safe. */
export function isValidKey(key: string): boolean {
  return KEY_SHAPE.test(key);
}

/** Thrown before any tool runs; its message never contains the key. */
export class InvalidKeyError extends Error {
  constructor() {
    super("the key must be 16-512 characters of letters, digits, '.', '_' or '-'");
    this.name = "InvalidKeyError";
  }
}

export function assertValidKey(key: string): void {
  if (!isValidKey(key)) throw new InvalidKeyError();
}

/** A store failure that names the store and the exit code, never stdin or the tool's output. */
export function storeFailure(label: string, action: string, result: RunResult): Error {
  const why = result.missing === true ? "tool not found" : `exit ${result.code ?? "signal"}`;
  return new Error(`could not ${action} the key in ${label} (${why})`);
}

/** Tool output minus one trailing line break. */
export function trimNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}
