// TDD ledger: the scaffold ships every behaviour as it.todo; done means none are left.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (path.endsWith(".test.ts")) yield path;
  }
}
let left = 0;
for await (const file of walk("test")) {
  const count = (await readFile(file, "utf8")).match(/\bit\.todo\(/g)?.length ?? 0;
  if (count) console.log(`${String(count).padStart(3)}  ${file}`);
  left += count;
}
console.log(`${left} it.todo left`);
process.exit(left ? 1 : 0);
