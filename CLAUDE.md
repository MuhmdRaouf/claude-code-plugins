# CLAUDE.md

**Hard rule: never credit Claude or any AI tool in git.** No `Co-Authored-By` trailer, no "Generated with Claude
Code" line, no session link, and no AI author or committer, in commits, pull requests, tags or release notes.
GitHub would list the tool as a contributor. `.claude/settings.json` turns Claude Code's attribution off;
`npm run check:attribution` must pass before anything is pushed. Commits are one line:
`<type>(<scope>): <message>`.

@AGENTS.md
