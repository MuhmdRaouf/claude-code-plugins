// The layering, checked: every import in src/ goes in an allowed direction, so a reader can trust that domain/ is pure,
// app/ reaches the world only through ports, and the hook and passthrough bundles stay small. A new edge that breaks a
// rule fails here, in CI, before it becomes the way things are done.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../../src");

/** What each layer may import: other layers (by their src/ folder), npm packages, node built-ins. */
const RULES: Readonly<
  Record<string, { layers: readonly string[]; packages: boolean; node: readonly string[] | "any" }>
> = {
  // Pure: the vocabulary and the rules. node:path only, for joining names.
  domain: { layers: [], packages: true, node: ["node:path"] },
  // The interfaces app/ needs from the world.
  ports: { layers: ["domain"], packages: false, node: [] },
  // The use cases: the world only through ports.
  app: { layers: ["domain", "ports"], packages: true, node: ["node:path"] },
  // The world.
  adapters: { layers: ["domain", "ports"], packages: true, node: "any" },
  // Text for people.
  render: { layers: ["domain", "ports", "app"], packages: true, node: ["node:path"] },
  // The key page: a small HTTP server and its launcher.
  "auth-page": { layers: ["domain", "ports", "adapters"], packages: true, node: "any" },
  // The router processes: domain facts and adapters, never the CLI or the use cases.
  router: { layers: ["domain", "ports", "adapters"], packages: true, node: "any" },
  // The composition root and the commands: anything.
  cli: {
    layers: ["domain", "ports", "app", "adapters", "render", "router", "auth-page"],
    packages: true,
    node: "any",
  },
};

/** Bundles that must start in milliseconds and load nothing that can break: node built-ins only, transitively. */
const BUILTIN_ONLY_ENTRIES = ["router/ensure.ts", "router/emergency.ts"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** What a file imports; `runtime` leaves out `import type`, which the bundler erases. */
function imports(file: string, runtime = false): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/^(import|export)( type)?[^;]*?from\s+"([^"]+)";/gms)]
    .filter((match) => !(runtime && match[2] !== undefined))
    .map((match) => match[3] as string);
}

const layerOf = (file: string): string => relative(SRC, file).split("/")[0] as string;

/** The imports of `file` its layer's rule does not allow, as `file -> spec`. */
function wrongImports(file: string): string[] {
  const layer = layerOf(file);
  const rule = RULES[layer];
  if (rule === undefined) return [];
  return imports(file)
    .filter((spec) => !allowed(rule, layer, file, spec))
    .map((spec) => `${relative(SRC, file)} -> ${spec}`);
}

function allowed(rule: (typeof RULES)[string] & object, layer: string, file: string, spec: string): boolean {
  if (spec.startsWith("node:")) return rule.node === "any" || rule.node.includes(spec);
  if (!spec.startsWith(".")) return rule.packages;
  const target = layerOf(resolve(dirname(file), spec));
  return target === layer || rule.layers.includes(target);
}

/** Every npm package `entry` loads at run time, followed through its relative imports. */
function packagesLoadedBy(entry: string): string[] {
  const seen = new Set<string>();
  const outside: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of imports(file, true)) {
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec));
      else if (!spec.startsWith("node:")) outside.push(`${relative(SRC, file)} -> ${spec}`);
    }
  };
  visit(entry);
  return outside;
}

describe("the import directions", () => {
  const files = sources(SRC);

  it("knows every layer", () => {
    expect([...new Set(files.map(layerOf))].sort()).toEqual(Object.keys(RULES).sort());
  });

  it("every import goes in an allowed direction", () => {
    expect(files.flatMap(wrongImports)).toEqual([]);
  });

  it.each(BUILTIN_ONLY_ENTRIES)("%s loads node built-ins only, all the way down", (entry) => {
    expect(packagesLoadedBy(join(SRC, entry))).toEqual([]);
  });
});
