#!/usr/bin/env node
// Fails when any commit in the history credits an AI tool. GitHub lists every author, committer and
// `Co-authored-by` identity as a contributor, so one stray trailer puts a bot on the repository page.
// Usage: node scripts/check-attribution.mjs [revision-range]   (default: HEAD, the whole history)
import { execFileSync } from "node:child_process";

const range = process.argv[2] ?? "HEAD";

// The identities AI coding tools commit or co-author as: their emails and bot accounts, not people's names.
const AI =
  /@anthropic\.com|claude-code|\bcopilot\b|cursoragent|@cursor\.com|codex|chatgpt|@openai\.com|devin-ai|\(aider\)|gemini-code-assist|google-labs-jules|amazon-q-developer|windsurf|codeium|tabnine|sweep-ai/i;
const TRAILER = /^(co-authored-by|signed-off-by|assisted-by|generated-by|created-by|written-by|claude-session)\s*:/i;
const GENERATED = /generated (with|by)|claude\.com\/claude-code|claude\.ai\/code/i;

const SEP = "\u001e";
const log = execFileSync(
  "git",
  ["log", "--no-color", `--format=%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B${SEP}`, range],
  { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
);

const problems = [];
for (const entry of log.split(SEP)) {
  const record = entry.replace(/^\n+/, "");
  if (record === "") continue;
  const [sha = "", author = "", committer = "", body = ""] = record.split("\u001f");
  const at = sha.slice(0, 7);
  if (AI.test(author)) problems.push(`${at} author ${author}`);
  if (AI.test(committer)) problems.push(`${at} committer ${committer}`);
  for (const line of body.split("\n")) {
    // Every co-author trailer fails: GitHub shows each one as a contributor.
    if (/^co-authored-by\s*:/i.test(line.trim())) problems.push(`${at} co-author: ${line.trim()}`);
    else if (TRAILER.test(line.trim()) && AI.test(line)) problems.push(`${at} trailer: ${line.trim()}`);
    else if (line.includes("🤖") || GENERATED.test(line)) problems.push(`${at} attribution line: ${line.trim()}`);
  }
}

if (problems.length > 0) {
  console.error("check-attribution: commits credit an AI tool (see AGENTS.md, Commits):");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("check-attribution: no AI attribution in the history");
