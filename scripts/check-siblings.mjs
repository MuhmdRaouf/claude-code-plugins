#!/usr/bin/env node
/**
 * The five provider plugins are hand-written copies of one another by design (no generator, each reads on its own).
 * This keeps them copies: every tracked file of every sibling is compared, file by file, with zai's after both are
 * normalised (the provider's name, NAME, display name, model ids and labels replaced by placeholders, also in paths).
 * A difference passes only when ALLOWED below names it with the reason; anything else fails with the first lines
 * that differ. `node scripts/check-siblings.mjs` from the repository root; part of `npm run check` and CI.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const REFERENCE = "zai";
const SIBLINGS = ["kimi", "deepseek", "minimax", "qwen"];

/** How the prose names each provider besides its display name: the model family and the vendor who issues the key.
 *  All of these, the display name and the capitalised name normalise to one <Brand> placeholder. */
const BRAND = {
  zai: ["GLM", "Z.ai"],
  kimi: ["Kimi", "Moonshot AI"],
  deepseek: ["DeepSeek"],
  minimax: ["MiniMax"],
  qwen: ["Qwen", "Alibaba Cloud"],
};

/**
 * Legitimate differences. `onlyReference`: files zai alone has; `onlySibling`: files a sibling alone may have;
 * `differs`: files whose normalised text may differ, per sibling or "*" for all four. Every entry says why.
 */
const ALLOWED = {
  onlyReference: {
    "stryker.config.mjs":
      "mutation testing runs on core and zai only; the siblings have no logic of their own",
    "test/app/drive.test.ts": "zai runs core's drive loop against its own fakes as the reference provider",
    "test/support/fake-claude.ts": "zai's golden transcript names its own copy; the siblings use core's",
    "test/support/fakes.ts": "zai's side of the shared fakes, for test/app",
    "test/fixtures/**": "recorded claude stream fixtures replayed by zai's e2e suite",
    "test/e2e/cli.test.ts": "the full CLI end to end runs once, on the reference provider",
    "test/e2e/epipe.test.ts": "the full CLI end to end runs once, on the reference provider",
    "test/e2e/follow.test.ts": "the full CLI end to end runs once, on the reference provider",
    "test/e2e/golden-flow.ts": "the golden transcript is recorded once, on the reference provider",
    "test/e2e/golden.test.ts": "the golden transcript is recorded once, on the reference provider",
    "test/e2e/golden/**": "the golden transcript is recorded once, on the reference provider",
    "test/e2e/harness.ts": "the full CLI end to end runs once, on the reference provider",
    "test/e2e/orphan.test.ts": "the full CLI end to end runs once, on the reference provider",
  },
  onlySibling: {},
  differs: {
    "src/provider.ts": {
      "*": "the provider's own data: endpoint, key variables, router port, strip and caveats",
    },
    "test/provider.test.ts": {
      "*": "zai checks it is core's reference provider; a sibling pins its own data",
    },
    "package.json": { "*": "description; zai alone carries Stryker (mutate)" },
    "vitest.config.ts": { "*": "zai alone has src/domain coverage thresholds" },
    "README.md": { "*": "vendor prose (models, prices, regions); reviewed in the docs pass" },
    "plugin/.claude-plugin/plugin.json": { "*": "the vendor's name in the description" },
    "biome.json": { "*": "zai alone lints stryker.config.mjs" },
  },
};

function tracked(plugin) {
  const dir = `plugins/${plugin}-plugin-cc`;
  return (
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", dir], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map((path) => path.slice(dir.length + 1))
      // The built bundles are checked fresh against src by each plugin's dist:fresh.
      .filter((path) => !/^plugin\/dist\/[^/]+\.js$/.test(path))
  );
}

/** The provider's names, longest first, as read from its src/provider.ts. */
function namesOf(plugin) {
  const source = readFileSync(join(ROOT, `plugins/${plugin}-plugin-cc/src/provider.ts`), "utf8");
  const field = (pattern, what) => {
    const match = pattern.exec(source);
    if (match === null) throw new Error(`${plugin}: cannot read ${what} from src/provider.ts`);
    return match[1];
  };
  const tier = (name) =>
    new RegExp(`${name}: \\{ tier: "${name}", id: "([^"]+)", label: "([^"]+)" \\}`).exec(source) ?? [];
  const [, mainId, mainLabel] = tier("main");
  const [, flashId, flashLabel] = tier("flash");
  const prefixes = JSON.parse(field(/modelPrefixes: (\[[^\]]*\])/, "modelPrefixes"));
  const pairs = [
    ...prefixes.map((prefix) => [`\`${prefix}*\``, "`<prefix>*`"]),
    [mainLabel, "<MainLabel>"],
    [flashLabel, "<FlashLabel>"],
    [mainId, "<main-id>"],
    [flashId, "<flash-id>"],
    [field(/display: "([^"]+)"/, "display"), "<Brand>"],
    ...BRAND[plugin].map((brand) => [brand, "<Brand>"]),
    [plugin.toUpperCase(), "<NAME>"],
    [plugin[0].toUpperCase() + plugin.slice(1), "<Brand>"],
    [plugin, "<name>"],
  ];
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

function normalise(text, names, path) {
  // Markdown prose is compared as words: how a paragraph wraps is no difference.
  let out = path.endsWith(".md") ? text.replace(/[ \t]*\n(?!\n)[ \t]*/g, " ") : text;
  for (const [from, to] of names) out = out.split(from).join(to);
  return out;
}

function matches(path, pattern) {
  return pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern;
}

function allowed(table, path) {
  return Object.keys(table).find((pattern) => matches(path, pattern));
}

/** The first differing lines of two texts, for the failure message. */
function firstDifference(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i++)
    if (left[i] !== right[i])
      return `line ${i + 1}:\n  ${REFERENCE}: ${left[i] ?? "<end>"}\n  sibling: ${right[i] ?? "<end>"}`;
  return "identical";
}

const failures = [];
const referenceNames = namesOf(REFERENCE);
const referenceFiles = new Map(tracked(REFERENCE).map((path) => [normalise(path, referenceNames, ""), path]));
for (const sibling of SIBLINGS) {
  const names = namesOf(sibling);
  const files = new Map(tracked(sibling).map((path) => [normalise(path, names, ""), path]));
  for (const [canonical, path] of referenceFiles) {
    if (files.has(canonical) || allowed(ALLOWED.onlyReference, canonical)) continue;
    failures.push(`${sibling}: missing ${canonical} (zai has ${path})`);
  }
  for (const [canonical, path] of files) {
    const reference = referenceFiles.get(canonical);
    if (reference === undefined) {
      if (!allowed(ALLOWED.onlySibling, canonical))
        failures.push(`${sibling}: ${path} has no counterpart in zai`);
      continue;
    }
    const ours = normalise(
      readFileSync(join(ROOT, `plugins/${sibling}-plugin-cc`, path), "utf8"),
      names,
      path,
    );
    const theirs = normalise(
      readFileSync(join(ROOT, `plugins/${REFERENCE}-plugin-cc`, reference), "utf8"),
      referenceNames,
      reference,
    );
    if (ours === theirs) continue;
    const rule = ALLOWED.differs[canonical];
    if (rule !== undefined && (rule["*"] !== undefined || rule[sibling] !== undefined)) continue;
    failures.push(
      `${sibling}: ${path} differs from zai's ${reference} after normalising names, ${firstDifference(theirs, ours)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(
    `check-siblings: ${failures.length} unexplained difference(s) between the provider plugins:\n`,
  );
  for (const failure of failures) console.error(`- ${failure}\n`);
  console.error(
    "Make the copies agree, or add the difference to ALLOWED in scripts/check-siblings.mjs with its reason.",
  );
  process.exit(1);
}
console.log(`check-siblings: ${SIBLINGS.join(", ")} match ${REFERENCE} file by file (normalised).`);
