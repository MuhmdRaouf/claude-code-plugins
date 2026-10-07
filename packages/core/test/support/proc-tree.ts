import { execFileSync } from "node:child_process";

/** pid → ppid for every process, from one `ps -A -o pid=,ppid=` snapshot. */
export function parentTable(): ReadonlyMap<number, number> {
  const table = new Map<number, number>();
  for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && ppid !== undefined && Number.isSafeInteger(pid) && Number.isSafeInteger(ppid))
      table.set(pid, ppid);
  }
  return table;
}

/** Every process whose ppid chain reaches `root` (root excluded): what a tree-kill of `root` signals. */
export function descendants(root: number, table: ReadonlyMap<number, number> = parentTable()): number[] {
  return [...table.keys()].filter((pid) => ancestors(pid, table).includes(root));
}

function ancestors(pid: number, table: ReadonlyMap<number, number>): number[] {
  const chain: number[] = [];
  for (let at = table.get(pid); at !== undefined && at > 0 && !chain.includes(at); at = table.get(at))
    chain.push(at);
  return chain;
}
