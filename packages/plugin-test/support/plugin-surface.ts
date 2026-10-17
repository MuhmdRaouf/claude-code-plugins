/**
 * The plugin surface every provider plugin ships, checked the same way for all five: the command and agent markdown
 * (front matter, the shipped Sonnet default, colors, triggering examples), the hooks, every CLI invocation against
 * the plugin-core binary's documented synopsis (its `--help`), no argument-hint or $ARGUMENTS, the launcher
 * references, and the setup menu and its engine commands. Each plugin's test/plugin/surface.test.ts calls
 * `describePluginSurface` with its own provider and `plugin/` dir and keeps only what is its own beside it.
 */
import { spawn } from "node:child_process";
import { cpSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { coreParity, expectCoreStarted, hostCli, runLauncher, writeCoreLauncher } from "./core-parity.ts";
import { CLAUDE_EFFORTS, type Provider } from "./provider.ts";
import { tempDir } from "./tmp.ts";

export interface PluginSurfaceOptions {
  readonly provider: Provider;
  /** The plugin's `plugin/` dir: what Claude Code installs. */
  readonly pluginDir: string;
}

/** The repository root and the Go core the binary is built from. */
const REPO_ROOT = join(import.meta.dirname, "../../..");
const CORE_GO = join(REPO_ROOT, "packages/core");

/** The plugin ships five commands, the built-in setup alone (setup/claude) and one setup command per delegation
 *  engine; the CLI keeps the rest of them for internal use. */
const COMMANDS = [
  "board",
  "remove",
  "review",
  "setup",
  "usage",
  "setup/claude",
  "setup/omp",
  "setup/opencode",
  "setup/pi",
  "setup/zcode",
];
/** Agent descriptions are read on every turn: they stay short. */
const MAX_DESCRIPTION_WORDS = 120;
const ENGINES = ["omp", "opencode", "pi", "zcode"] as const;
const AGENT_COLORS = ["blue", "cyan", "green", "yellow", "magenta", "red"] as const;
const GLOBAL_FLAGS = ["--json"];
const INTERNAL_COMMANDS = ["drive"];
/**
 * Flags the CLI accepts (its command's option table in the Go core) that the help's one-line synopses leave out;
 * the plugin's surface uses them: the hooks run `--hook`, the engine agents name `run --engine`.
 */
const FLAGS_THE_HELP_OMITS: Readonly<Record<string, readonly string[]>> = {
  run: ["--engine"],
  board: ["--hook"],
  setup: ["--hook"],
  usage: ["--hook"],
};

interface FrontMatterDoc {
  readonly data: unknown;
  readonly body: string;
}

function splitFrontMatter(text: string): FrontMatterDoc | undefined {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) return undefined;
  return { data: parseYaml(match[1] ?? ""), body: match[2] ?? "" };
}

/** One run of the plugin-core binary, its stdout (the help never writes stderr on a clean temp home). */
async function binaryHelp(name: string, args: readonly string[]): Promise<string> {
  const home = tempDir(`${name}-surface-`);
  const child = spawn(hostCli(), [name, "cli", ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  if (code !== 0) throw new Error(`plugin-core ${name} cli ${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout;
}

/**
 * Parses the binary's `--help` into command → documented flags: every two-space-indented synopsis line names one
 * command (its first word) and the flags its line shows. `--json` is global (the help's header line says so), so it
 * belongs to no command's set.
 */
async function cliSynopsis(name: string): Promise<Map<string, Set<string>>> {
  const help = await binaryHelp(name, ["--help"]);
  const synopsis = new Map<string, Set<string>>();
  for (const line of help.split("\n")) {
    const command = /^ {2}([a-z]+) /.exec(line)?.[1];
    if (command === undefined) continue;
    const flags = synopsis.get(command) ?? new Set<string>();
    for (const flag of line.match(/--[a-z][a-z-]*/g) ?? []) if (!GLOBAL_FLAGS.includes(flag)) flags.add(flag);
    synopsis.set(command, flags);
  }
  return synopsis;
}

interface Invocation {
  readonly file: string;
  readonly command: string;
  readonly flags: readonly string[];
}

function toolList(tools: string | readonly string[]): string[] {
  return typeof tools === "string" ? tools.split(",").map((tool) => tool.trim()) : [...tools];
}

const toolsField = z.union([z.string(), z.array(z.string())]);

const AgentFrontMatter = z
  .object({
    name: z.string(),
    description: z.string(),
    model: z.string(),
    effort: z.enum(CLAUDE_EFFORTS),
    color: z.enum(AGENT_COLORS),
    tools: toolsField.optional(),
  })
  .strict();

const CommandFrontMatter = z
  .object({
    description: z.string().min(1),
    "allowed-tools": toolsField,
    "argument-hint": z.string().optional(),
    "disable-model-invocation": z.boolean().optional(),
  })
  .strict();

const HooksFile = z
  .object({
    description: z.string().optional(),
    hooks: z.record(
      z.string(),
      z.array(
        z
          .object({
            matcher: z.string().optional(),
            hooks: z.array(
              z
                .object({ type: z.literal("command"), command: z.string(), timeout: z.number().optional() })
                .strict(),
            ),
          })
          .strict(),
      ),
    ),
  })
  .strict();

/** Readers over one plugin's `plugin/` dir. */
function surfaceOf(pluginDir: string, name: string) {
  const invocation = new RegExp(
    `sh "\\$\\{CLAUDE_PLUGIN_ROOT\\}/dist/run" ${name}\\.js ([a-z]+)([^\`\\n]*)`,
    "g",
  );
  const readPluginFile = (relative: string): string => readFileSync(join(pluginDir, relative), "utf8");
  /** The file's text as its consumer sees it: JSON string escapes (`\"`) undone. */
  const surfaceText = (relative: string): string => {
    const text = readPluginFile(relative);
    return relative.endsWith(".json") ? text.replaceAll('\\"', '"') : text;
  };
  const markdownFiles = (dir: string): string[] =>
    readdirSync(join(pluginDir, dir))
      .filter((file) => file.endsWith(".md"))
      .map((file) => `${dir}/${file}`)
      .sort();
  /** commands/*.md and the engine setup commands in commands/setup/ (`/<plugin>:setup:<engine>`). */
  const commandFiles = (): string[] => [...markdownFiles("commands"), ...markdownFiles("commands/setup")];
  const allSurfaceFiles = (): string[] => [...markdownFiles("agents"), ...commandFiles(), "hooks/hooks.json"];
  const frontMatterOf = (relative: string): FrontMatterDoc => {
    const doc = splitFrontMatter(readPluginFile(relative));
    if (doc === undefined) throw new Error(`${relative}: no front matter`);
    return doc;
  };
  const invocationsIn = (file: string): Invocation[] =>
    [...surfaceText(file).matchAll(invocation)].map((match) => ({
      file,
      command: match[1] ?? "",
      flags: (match[2] ?? "").match(/--[a-z][a-z-]*/g) ?? [],
    }));
  return {
    readPluginFile,
    surfaceText,
    markdownFiles,
    commandFiles,
    allSurfaceFiles,
    frontMatterOf,
    invocationsIn,
  };
}

/** The shared surface checks for one provider plugin. */
export function describePluginSurface(options: PluginSurfaceOptions): void {
  const { provider: PROVIDER, pluginDir } = options;
  const { name: plugin } = PROVIDER;
  const {
    readPluginFile,
    surfaceText,
    markdownFiles,
    commandFiles,
    allSurfaceFiles,
    frontMatterOf,
    invocationsIn,
  } = surfaceOf(pluginDir, plugin);
  /** The two model agents are named by the catalog's model ids (PROVIDER.agents), so a model bump renames them. They
   *  ship on Sonnet; `/<plugin>:setup` rewrites them to the provider's ids. Both are full coder agents: neither is
   *  read-only. */
  const AGENT_NAMES = [PROVIDER.agents.main, PROVIDER.agents.flash];
  /** Every slash command a surface file or a rendered message may name. */
  const SLASH_COMMANDS = COMMANDS.map((command) => `${PROVIDER.slash}${command.replace("/", ":")}`);
  /** Both model agents carry exactly this tools line. */
  const MODEL_AGENT_TOOLS = [
    "Agent",
    "Bash",
    "Edit",
    "Glob",
    "Grep",
    "LSP",
    "ListMcpResourcesTool",
    "Monitor",
    "NotebookEdit",
    "Read",
    "ReadMcpResourceTool",
    "Skill",
    "TaskStop",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
    "Write",
  ] as const;

  describe(`plugin surface of ${plugin}`, () => {
    it("is installed as <name>-plugin-cc from this plugin/ dir, named <name>, and ships its licence", () => {
      const manifest = JSON.parse(readPluginFile(".claude-plugin/plugin.json")) as {
        name: string;
        license: string;
      };
      const marketplace = JSON.parse(
        readFileSync(join(REPO_ROOT, ".claude-plugin/marketplace.json"), "utf8"),
      ) as {
        plugins: { name: string; source: string }[];
      };
      const entry = marketplace.plugins.find(
        (plugin) => resolve(REPO_ROOT, plugin.source) === resolve(pluginDir),
      );

      // The slash namespace and the data dir prefix (`data/<entry>-<marketplace>`) both rest on these names.
      expect(manifest.name).toBe(plugin);
      expect(entry?.name).toBe(`${plugin}-plugin-cc`);
      expect(manifest.license).toBe("GPL-3.0-or-later");
      expect(readPluginFile("LICENSE")).toBe(readFileSync(join(REPO_ROOT, "LICENSE"), "utf8"));
    });

    it("reads the documented command set from the plugin-core binary's help", async () => {
      const synopsis = await cliSynopsis(plugin);

      expect([...synopsis.keys()].sort()).toEqual(
        [
          "accept",
          "batch",
          "board",
          "brief",
          "discard",
          "return",
          "review",
          "run",
          "setup",
          "show",
          "stop",
          "usage",
          "wait",
        ].sort(),
      );
      expect([...(synopsis.get("run") ?? [])].sort()).toEqual(["--bg", "--flash", "--mode", "--wait"]);
    });

    it("every agent and command markdown file has YAML front matter (a mapping) and a non-empty body", () => {
      for (const file of [...markdownFiles("agents"), ...commandFiles()]) {
        const doc = splitFrontMatter(readPluginFile(file));

        expect(doc, `${file}: front matter`).toBeDefined();
        expect(z.record(z.string(), z.unknown()).safeParse(doc?.data).success, `${file}: mapping`).toBe(true);
        expect(doc?.body.trim().length ?? 0, `${file}: body`).toBeGreaterThan(0);
      }
    });

    it(`agents ${AGENT_NAMES.join(" and ")}: name matches the file, the shipped sonnet default, effort max, distinct colors, triggering examples`, () => {
      expect(markdownFiles("agents")).toEqual(
        [...AGENT_NAMES, ...ENGINES].map((name) => `agents/${name}.md`).sort(),
      );
      const colors = new Set<string>();
      for (const name of AGENT_NAMES) {
        const fm = AgentFrontMatter.parse(frontMatterOf(`agents/${name}.md`).data);

        expect(fm.name).toBe(name);
        expect(fm.model).toBe("sonnet");
        expect(fm.effort).toBe("max");
        expect(fm.tools === undefined ? undefined : toolList(fm.tools), `${name}: tools`).toEqual(
          MODEL_AGENT_TOOLS,
        );
        expect(fm.description).toMatch(/^Use this agent/);
        expect(fm.description).toContain("Sonnet");
        // Says when it runs on its own model, naming the setup command whole (a broken substitution once left
        // "once /<p> Code at the <p> router").
        expect(fm.description).toContain(
          `It runs on ${name} once ${PROVIDER.slash}setup has pointed Claude Code at the ${PROVIDER.name} router, and on Sonnet before that or while the router is down.`,
        );
        expect(fm.description).not.toMatch(/\/[a-z]+ Code at the/);
        expect(fm.description.match(/\S+/g)?.length ?? 0, `${name}: words`).toBeLessThan(
          MAX_DESCRIPTION_WORDS,
        );
        expect(fm.description).toContain(PROVIDER.display);
        expect(fm.description.match(/<example>/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
        colors.add(fm.color);
      }
      expect(colors.size).toBe(AGENT_NAMES.length);
    });

    it("agents do the work themselves: no CLI dispatch, no plugin CLI at all, and never commit or read secrets", () => {
      for (const name of AGENT_NAMES) {
        const file = `agents/${name}.md`;
        const text = readPluginFile(file);

        expect(invocationsIn(file)).toEqual([]);
        expect(text).toMatch(new RegExp(`[Nn]ever invoke the ${plugin} plugin`));
        expect(text).toMatch(/[Nn]ever (commit|change anything)/);
        expect(text).toMatch(/secrets/);
      }
    });

    it("ships exactly board, remove, review, setup, usage and setup/{claude,omp,opencode,pi,zcode}", () => {
      expect(commandFiles().sort()).toEqual(COMMANDS.map((command) => `commands/${command}.md`).sort());
    });

    it("every command declares a description and allowed-tools Bash(sh:*) (the launcher), and invokes its own CLI command", () => {
      for (const file of commandFiles()) {
        const fm = CommandFrontMatter.parse(frontMatterOf(file).data);
        // commands/setup/<engine>.md is `/<plugin>:setup:<engine>`, and remove is `setup --remove`: they run setup.
        const command =
          file.startsWith("commands/setup/") || file === "commands/remove.md"
            ? "setup"
            : basename(file, ".md");

        expect(toolList(fm["allowed-tools"]), file).toEqual(["Bash(sh:*)"]);
        expect(
          invocationsIn(file).some((call) => call.command === command),
          `${file} invokes ${command}`,
        ).toBe(true);
      }
    });

    it("only review takes an argument (a job id), and no command says it takes none", () => {
      for (const file of commandFiles()) {
        const takes = file === "commands/review.md";
        expect(CommandFrontMatter.parse(frontMatterOf(file).data)["argument-hint"], file).toBe(
          takes ? "[job id]" : undefined,
        );
        expect(readPluginFile(file).includes("$ARGUMENTS"), file).toBe(takes);
      }
      // `setup` has flags (--remove); the engine setups are worded elsewhere.
      const engineSetups = ENGINES.map((engine) => `commands/setup/${engine}.md`);
      for (const file of commandFiles().filter((command) => !engineSetups.includes(command)))
        expect(readPluginFile(file), `${file}: "takes no arguments"`).not.toContain("takes no arguments");
    });

    it("no --route anywhere on the surface", () => {
      for (const file of allSurfaceFiles())
        expect(surfaceText(file), `${file}: --route`).not.toContain("--route");
    });

    it("every CLI invocation, hooks included, names a documented command with documented flags", async () => {
      const synopsis = await cliSynopsis(plugin);
      const invocations = allSurfaceFiles().flatMap(invocationsIn);

      expect(invocations.length).toBeGreaterThan(0);
      for (const call of invocations) {
        const documented = synopsis.get(call.command);
        const allowed = [
          ...(documented ?? []),
          ...(FLAGS_THE_HELP_OMITS[call.command] ?? []),
          ...GLOBAL_FLAGS,
        ];

        expect(documented, `${call.file}: ${call.command} is a CLI command`).toBeDefined();
        expect(INTERNAL_COMMANDS, `${call.file}: ${call.command} is internal`).not.toContain(call.command);
        expect(
          call.flags.filter((flag) => !allowed.includes(flag)),
          `${call.file}: ${call.command} flags`,
        ).toEqual([]);
      }
    });

    it(`every \${CLAUDE_PLUGIN_ROOT} reference is the quoted launcher "\${CLAUDE_PLUGIN_ROOT}/dist/run" starting ${plugin}.js, ${plugin}-router.js or ${plugin}-ensure.js`, () => {
      let total = 0;
      for (const file of allSurfaceFiles()) {
        const text = surfaceText(file);
        const references = text.match(/\$\{?CLAUDE_PLUGIN_ROOT\}?/g) ?? [];
        const canonical =
          text.match(
            new RegExp(`"\\$\\{CLAUDE_PLUGIN_ROOT\\}/dist/run" ${plugin}(-router|-ensure)?\\.js`, "g"),
          ) ?? [];

        expect(canonical.length, file).toBe(references.length);
        total += references.length;
      }
      expect(total).toBeGreaterThan(0);
    });

    it("hooks.json: SessionStart re-applies the setup (15 s) then runs board --hook (5 s); every prompt, tool call and subagent start runs ensure (3 s)", () => {
      const hooks = HooksFile.parse(JSON.parse(readPluginFile("hooks/hooks.json")));
      const sessionStart = (hooks.hooks.SessionStart ?? []).flatMap((group) => group.hooks);
      const ensure = {
        type: "command",
        command: `sh "\${CLAUDE_PLUGIN_ROOT}/dist/run" ${plugin}-ensure.js --hook`,
        timeout: 3,
      };

      expect(Object.keys(hooks.hooks)).toEqual([
        "SessionStart",
        "UserPromptSubmit",
        "SubagentStart",
        "PreToolUse",
        "SubagentStop",
      ]);
      expect(sessionStart).toEqual([
        {
          type: "command",
          command: `sh "\${CLAUDE_PLUGIN_ROOT}/dist/run" ${plugin}.js setup --hook`,
          timeout: 15,
        },
        {
          type: "command",
          command: `sh "\${CLAUDE_PLUGIN_ROOT}/dist/run" ${plugin}.js board --hook`,
          timeout: 5,
        },
      ]);
      expect((hooks.hooks.UserPromptSubmit ?? []).flatMap((group) => group.hooks)).toEqual([ensure]);
      expect((hooks.hooks.SubagentStart ?? []).flatMap((group) => group.hooks)).toEqual([ensure]);
      // A turn's next tool call brings a router that died mid-turn back (the session watchdog
      // covers the gap between hooks).
      expect((hooks.hooks.PreToolUse ?? []).flatMap((group) => group.hooks)).toEqual([ensure]);
      // After a model agent: one line for the user on what it ran on, inside a 2 s timeout (the hook aims under 1 s).
      expect((hooks.hooks.SubagentStop ?? []).flatMap((group) => group.hooks)).toEqual([
        {
          type: "command",
          command: `sh "\${CLAUDE_PLUGIN_ROOT}/dist/run" ${plugin}.js usage --hook`,
          timeout: 2,
        },
      ]);
    });
    it("setup.md always asks what to set up: built-in only, or built-in plus the tools it then asks for", () => {
      const file = "commands/setup.md";
      const text = readPluginFile(file);
      const calls = invocationsIn(file);

      expect(calls.slice(0, 2)).toEqual([
        { file, command: "setup", flags: ["--engines", "--json"] },
        { file, command: "setup", flags: [] },
      ]);
      expect(calls).toContainEqual({ file, command: "setup", flags: ["--engine-check", "--json"] });
      expect(text).toContain("AskUserQuestion every time it runs");
      expect(text).toContain("never skip one as already answered");
      expect(text).toContain(`"What should ${PROVIDER.display} set up?"`);
      expect(text).toContain("`Built-in only (Claude Code agents and /model)`");
      expect(text).toContain("`Built-in plus other tools (omp, opencode, pi, zcode)`");
      expect(text).toContain(
        "multiSelect, one option per tool in this order: `omp`, `opencode`, `pi`, `zcode`",
      );
      expect(text).toContain(" (installed)");
      expect(text).toContain(" (not found)");
      expect(text).toContain(" (current)");
      expect(text).toContain("setup --engine-enable <tool> --watcher provider");
      expect(text).toContain("setup --engine-enable <tool> --watcher sonnet");
      expect(text).toContain(`\`${PROVIDER.catalog.main.label} (${PROVIDER.display})\``);
      expect(text).toContain("never disables an engine");
      for (const agent of AGENT_NAMES) expect(text).toContain(`${PROVIDER.agentPrefix}${agent}`);
    });

    it("setup/claude.md is the built-in setup alone: plain setup, no question", () => {
      const file = "commands/setup/claude.md";

      expect(invocationsIn(file)).toEqual([{ file, command: "setup", flags: [] }]);
      expect(readPluginFile(file)).not.toContain("AskUserQuestion");
      expect(readPluginFile(file)).toContain(`\`${PROVIDER.slash}setup\` asks what to set up`);
    });

    it.each(ENGINES)(
      "setup/%s.md checks the engine, always asks who watches with both options, then enables it",
      (engine) => {
        const file = `commands/setup/${engine}.md`;
        const text = readPluginFile(file);
        const calls = invocationsIn(file);

        expect(calls).toContainEqual({ file, command: "setup", flags: ["--engine-check", "--json"] });
        expect(text).toContain(`setup --engine-check ${engine} --json`);
        expect(text).toContain(`setup --engine-enable ${engine} --watcher provider`);
        expect(text).toContain(`setup --engine-enable ${engine} --watcher sonnet`);
        expect(text).toContain("AskUserQuestion");
        expect(text).toMatch(/always, every time this command runs/);
        expect(text).toContain(`"Who should watch ${engine} runs?"`);
        expect(text).toContain(`${PROVIDER.catalog.main.label} (${PROVIDER.display})`);
        expect(text).toContain("`Claude Sonnet`");
        expect(text).toContain(" (current)");
      },
    );

    it.each(ENGINES)(
      "agent %s: ships on Sonnet, names its setup command, runs the job on its engine and never decides",
      (engine) => {
        const file = `agents/${engine}.md`;
        const doc = frontMatterOf(file);
        const fm = AgentFrontMatter.parse(doc.data);
        const calls = invocationsIn(file);

        expect(fm.name).toBe(engine);
        expect(fm.model).toBe("sonnet");
        expect(toolList(fm.tools ?? [])).toEqual(["Bash", "Read", "Grep", "Glob"]);
        expect(fm.description).toMatch(/^Use this agent/);
        expect(fm.description).toContain(`${PROVIDER.slash}setup:${engine}`);
        expect(fm.description).toContain(PROVIDER.display);
        expect(fm.description.match(/<example>/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
        expect(calls).toContainEqual({ file, command: "run", flags: ["--engine", "--bg"] });
        expect(doc.body).toContain(`run - --engine ${engine} --bg`);
        expect(calls.map((call) => call.command)).toEqual(
          expect.arrayContaining(["run", "wait", "review", "accept", "return", "discard"]),
        );
        expect(doc.body).toContain("run_in_background");
        expect(doc.body).toMatch(/Never accept, return or discard the job yourself/);
        expect(doc.body).toContain(`${PROVIDER.slash}setup:${engine}`);
      },
    );

    it("the engine agents have three distinct colors, none shared with the main and flash agents", () => {
      const colors = [...AGENT_NAMES, ...ENGINES].map(
        (name) => AgentFrontMatter.parse(frontMatterOf(`agents/${name}.md`).data).color,
      );

      expect(new Set(colors).size).toBe(colors.length);
    });

    it("every slash command the surface or the core's messages name is one the plugin ships", () => {
      const named = (text: string): string[] =>
        [
          ...text.matchAll(new RegExp(`${PROVIDER.slash.replace(/[/:]/g, "\\$&")}[a-z]+(?::[a-z]+)?`, "g")),
        ].map((match) => match[0]);
      for (const file of allSurfaceFiles()) {
        for (const command of named(surfaceText(file)))
          expect(SLASH_COMMANDS, `${file}: ${command}`).toContain(command);
      }
      // The Go core renders `${provider.Slash}<command>`: each must exist in every plugin.
      const coreNames = (dir: string): string[] =>
        readdirSync(join(CORE_GO, dir), { recursive: true, encoding: "utf8" })
          .filter((file) => file.endsWith(".go"))
          .flatMap((file) =>
            [
              ...readFileSync(join(CORE_GO, dir, file), "utf8").matchAll(
                /\.Slash\s*\+\s*"([a-z]+(?::[a-z]+)?)/g,
              ),
            ].map((match) => `${PROVIDER.slash}${match[1]}`),
          );
      const fromCore = [...coreNames("internal/render"), ...coreNames("internal/cli")];
      expect(fromCore.length).toBeGreaterThan(0);
      for (const command of fromCore) expect(SLASH_COMMANDS, `core: ${command}`).toContain(command);
    });

    it("remove runs setup --remove and says to uninstall after it; review never offers accept on a crashed job", () => {
      expect(invocationsIn("commands/remove.md")).toEqual([
        { file: "commands/remove.md", command: "setup", flags: ["--remove"] },
      ]);
      expect(readPluginFile("commands/remove.md")).toContain(
        `/plugin uninstall ${plugin}-plugin-cc@muhmdraouf`,
      );
      for (const file of ["commands/setup.md", "commands/setup/claude.md"]) {
        expect(readPluginFile(file), file).toContain(
          `run \`${PROVIDER.slash}remove\`, then \`/plugin uninstall`,
        );
        expect(readPluginFile(file), file).not.toContain("remove `env.ANTHROPIC_BASE_URL` first");
      }
      const review = readPluginFile("commands/review.md");
      expect(invocationsIn("commands/review.md").map((call) => call.command)).toEqual(
        expect.arrayContaining(["board", "review", "accept", "return", "discard"]),
      );
      expect(review).toContain("Never offer accept.");
      expect(review).toContain("AskUserQuestion");
    });

    it("the launcher dist/run starts the installed plugin-core binary (its installed-binary step)", async () => {
      const parity = coreParity(`${plugin}-surface-`);
      const home = tempDir(`${plugin}-surface-`);
      const root = tempDir(`${plugin}-surface-parity-`);
      cpSync(pluginDir, root, { recursive: true });
      writeCoreLauncher(root, plugin, parity);
      const help = await runLauncher(root, `${plugin}.js`, ["--help"], {
        PATH: process.env.PATH ?? "",
        HOME: home,
        [`${PROVIDER.envPrefix}_STATE_DIR`]: join(home, "state"),
        ...parity.env,
      });

      expect(help.code).toBe(0);
      expect(help.stderr).toBe("");
      expect(help.stdout).toContain(`there is no ${plugin} command on PATH`);
      expectCoreStarted(parity);
    });
  });
}
