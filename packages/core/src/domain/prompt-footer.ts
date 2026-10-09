import type { Brief } from "./brief.ts";
import { fenced } from "./prompt-fence.ts";
import { lines } from "./prompt-text.ts";
import type { Provider } from "./provider.ts";

const NO_COMMITS = "Do not commit, stage, stash or switch branches.";
const NO_SECRETS = "Never print, log or write secrets: API keys, tokens, passwords, private keys.";

/** The fixed contract appended to every fresh prompt, written for GLM: imperative, one rule per line. */
export function contractFooter(brief: Brief, artifactsDir: string, provider: Provider): string {
  return lines([
    `## ${provider.name} contract`,
    "",
    ...workspaceRules(brief, artifactsDir, provider.artifactsEnv),
    NO_COMMITS,
    NO_SECRETS,
    "",
    "## Gates",
    "",
    ...gateRules(brief),
    "",
    "## Finish",
    "",
    ...finishRules(brief),
  ]);
}

function finishRules(brief: Brief): readonly string[] {
  return [
    ...(brief.gates.length === 0 ? [] : ["Run the gates yourself before you finish. Fix what fails."]),
    `End your run with the structured report (${reportName(brief.report)}). Report only what you did and checked.`,
  ];
}

function reportName(report: Brief["report"]): string {
  return report.kind === "builtin" ? `schema: ${report.name}` : `schema file: ${report.path}`;
}

function gateRules(brief: Brief): readonly string[] {
  if (brief.gates.length === 0) return ["No gates: the plugin runs no checks after you finish."];
  return [
    "After you finish, the plugin runs these commands in your workspace. Each must exit 0.",
    fenced(brief.gates.map((gate) => gate.run).join("\n"), "sh"),
  ];
}

function workspaceRules(brief: Brief, artifactsDir: string, artifactsEnv: string): readonly string[] {
  switch (brief.mode) {
    case "edit":
      return editRules(brief);
    case "exec":
      return [
        "You work directly in the repository. The repository must stay unchanged.",
        "Do not create, edit or delete files in it.",
        `Write every output file to ${artifactsDir} (also in $${artifactsEnv}).`,
      ];
    case "readonly":
      return [
        "This is a read-only investigation. Read and search; run only commands that change nothing.",
        "Do not create, edit or delete any file.",
      ];
  }
}

function editRules(brief: Brief): readonly string[] {
  return [
    "You work in an isolated git worktree of the repository. Edit files only there.",
    "Change only files matching these globs:",
    ...brief.scope.map(bullet),
    ...(brief.forbid.length === 0
      ? []
      : ["Never touch files matching these globs, even inside scope:", ...brief.forbid.map(bullet)]),
    "Leave your changes in the working tree. The plugin reviews and commits them.",
  ];
}

function bullet(glob: string): string {
  return `- \`${glob}\``;
}
