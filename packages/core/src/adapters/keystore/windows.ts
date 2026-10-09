// Windows: the key protected with DPAPI for the current user, in %APPDATA%\<service>\key.dpapi. PowerShell reads its
// script from stdin (`-Command -`); the script reads the key from the next stdin line, so neither reaches argv.

import type { KeyStore } from "../../ports/keys.ts";
import { assertValidKey, type KeyIdentity, type Runner, storeFailure, trimNewline } from "./port.ts";

export const POWERSHELL = "powershell";
export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command", "-"] as const;
const LABEL = "Windows DPAPI";
/** Exit code of the read script when no key file exists. */
const NO_KEY = 3;

/** One line each: `-Command -` runs stdin line by line, and the set script's ReadLine takes the line after it. */
function scripts(service: string): { readonly set: string; readonly get: string; readonly remove: string } {
  const dir = `(Join-Path $env:APPDATA '${service}')`;
  const file = `(Join-Path ${dir} 'key.dpapi')`;
  const strict = "$ErrorActionPreference='Stop'";
  return {
    set: [
      strict,
      "$k=[Console]::In.ReadLine()",
      `New-Item -ItemType Directory -Force -Path ${dir} | Out-Null`,
      `$k | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -NoNewline -Path ${file}`,
      "exit 0",
    ].join("; "),
    get: [
      strict,
      `$f=${file}`,
      `if (-not (Test-Path $f)) { exit ${NO_KEY} }`,
      "$s=(Get-Content -Raw $f).Trim() | ConvertTo-SecureString",
      "[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)))",
      "exit 0",
    ].join("; "),
    remove: [`Remove-Item -Force -ErrorAction SilentlyContinue -Path ${file}`, "exit 0"].join("; "),
  };
}

export function windowsKeyStore(id: KeyIdentity, run: Runner): KeyStore {
  const script = scripts(id.service);
  const powershell = (stdin: string) => run(POWERSHELL, POWERSHELL_ARGS, stdin);
  return {
    kind: "windows",
    label: LABEL,
    async available() {
      const result = await powershell("exit 0\n");
      return result.missing !== true && result.code === 0;
    },
    async get() {
      const result = await powershell(`${script.get}\n`);
      if (result.code !== 0) return undefined;
      return trimNewline(result.stdout) || undefined;
    },
    async set(key) {
      assertValidKey(key);
      const result = await powershell(`${script.set}\n${key}\n`);
      if (result.code !== 0) throw storeFailure(LABEL, "store", result);
    },
    async remove() {
      const result = await powershell(`${script.remove}\n`);
      if (result.code !== 0) throw storeFailure(LABEL, "remove", result);
    },
  };
}
