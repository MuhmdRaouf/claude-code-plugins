// src/rules.ts — the approval rules: shell commands the owner wants to be asked about before a
// session in their channel runs them. Pure (no imports): the PreToolUse hook (hooks/approve.ts)
// loads it on every Bash call and matches locally, so a command that matches no rule costs no
// network at all. The server keeps which rules are on per channel (src/extras.ts); the hook only
// asks the server when a command could match one.
//
// A rule never denies and never waits: a match makes Claude Code show its own permission prompt
// ("ask"), the user answers there, and the owner sees the request in the dashboard's Inbox.

export type Rule = { id: string; label: string; help: string; on: boolean; re: RegExp[] };

// a command word at the start of the line or after a shell separator (; & | && || ( ` $( sudo …)
const W = String.raw`(?:^|[;&|(\x60]|\$\(|\bsudo\s+|\bexec\s+|\bthen\s+|\bdo\s+)\s*`;
// the end of a command word: "push" but not "push-helper"
const E = String.raw`(?![\w-])`;
const git = (sub: string) => String.raw`${W}git(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+${sub}`;

export const RULES: Rule[] = [
  { id: "force_push", label: "Force push", help: "git push --force, -f, --force-with-lease or a +ref", on: true,
    re: [new RegExp(git(String.raw`push${E}[^;&|\n]*?(?:\s--force(?:-with-lease)?\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s\+\S)`))] },
  { id: "delete", label: "Delete files or branches", help: "rm, git rm, git clean, git branch -d/-D, git push --delete, find -delete, rmdir, unlink", on: true,
    re: [new RegExp(`${W}(?:rm|rmdir|unlink|shred|trash)${E}(?!\\s*=)`), new RegExp(git(String.raw`(?:rm|clean)${E}`)),
      new RegExp(git(String.raw`branch${E}[^;&|\n]*\s(?:-[a-zA-Z]*[dD]\b|--delete\b)`)),
      new RegExp(git(String.raw`push${E}[^;&|\n]*(?:\s--delete\b|\s-d\b|\s:\S)`)),
      new RegExp(String.raw`${W}find\b[^;&|\n]*\s-delete\b`)] },
  { id: "git_push", label: "Git push", help: "every git push", on: false, re: [new RegExp(git(String.raw`push${E}`))] },
  { id: "git_tag", label: "Git tag", help: "creating, moving or deleting a tag (listing is fine)", on: false,
    re: [new RegExp(git(String.raw`tag${E}(?!\s*(?:$|[;&|)]|-l\b|--list\b|-n\d*\b|--contains\b|--points-at\b|--merged\b|--no-merged\b|--sort\b|--format\b|-v\b|--verify\b))`))] },
  { id: "publish", label: "Publish a package", help: "npm/pnpm/yarn/bun publish, cargo publish, twine upload, gem push, poetry/uv/flit publish, docker push, gh release create", on: false,
    re: [new RegExp(`${W}(?:npm|pnpm|yarn|bun|cargo|poetry|uv|flit|vsce|ovsx|hatch)\\s+(?:[\\w-]+\\s+)?publish${E}`),
      new RegExp(`${W}(?:python3?\\s+-m\\s+)?twine\\s+upload${E}`), new RegExp(`${W}gem\\s+push${E}`),
      new RegExp(`${W}docker\\s+(?:image\\s+)?push${E}`), new RegExp(`${W}gh\\s+release\\s+create${E}`)] },
];

/** The default switch of every rule (force push and deleting on, the rest off). */
export const DEFAULTS: Record<string, boolean> = Object.fromEntries(RULES.map(r => [r.id, r.on]));

/** The rules a command matches, in the order above (it may match several: force push is a push). */
export function matching(command: string): Rule[] {
  const c = String(command ?? "");
  if (!c.trim() || c.length > 100_000) return [];
  return RULES.filter(r => r.re.some(x => x.test(c)));
}

/** A channel's switches: its stored ones over the defaults; unknown ids are dropped. */
export function effective(stored: unknown): Record<string, boolean> {
  const out = { ...DEFAULTS };
  if (stored && typeof stored === "object") for (const [k, v] of Object.entries(stored)) if (k in out && typeof v === "boolean") out[k] = v;
  return out;
}
