// Composition root: wires adapters into Deps and hands argv to runCli. Kept free of logic (excluded from coverage).
import { runCli } from "@muhmdraouf/core/cli/run.ts";
import { wire } from "@muhmdraouf/core/cli/wire.ts";
import { QWEN_PROVIDER } from "../provider.ts";

// A closed pipe (`qwen run --bg | head -1`) ends the CLI quietly instead of an EPIPE stack trace. Node reports it as an
// 'error' event on stdout; Bun 1.3 only to the write's callback, so every stdout write checks it too.
process.stdout.on("error", (error) => {
  if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
  process.exit(0);
});
const closedPipe = (error?: Error | null): void => {
  if ((error as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") process.exit(0);
};
const write = (stream: NodeJS.WriteStream) => (text: string) =>
  stream.write(`${text}\n`, stream === process.stdout ? closedPipe : undefined);
const argv = process.argv.slice(2);
let code: number;
try {
  const deps = wire({
    provider: QWEN_PROVIDER,
    env: process.env,
    bundlePath: process.argv[1] ?? "",
    out: { line: write(process.stdout), error: write(process.stderr) },
  });
  code = await runCli(argv, deps, process.cwd());
} catch (error) {
  // A hook never fails a session: on the hook path anything unexpected (a read-only home, a missing file) is silent.
  if (!argv.includes("--hook")) throw error;
  code = 0;
}
// Pipes are asynchronous: exit only once both streams have flushed.
await Promise.all(
  [process.stdout, process.stderr].map((stream) => new Promise((done) => stream.write("", done))),
);
process.exit(code);
