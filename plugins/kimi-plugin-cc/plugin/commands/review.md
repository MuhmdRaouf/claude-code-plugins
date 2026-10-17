---
description: Review a kimi job and decide it — accept, return with feedback, or discard
argument-hint: "[job id]"
allowed-tools: Bash(sh:*)
---

Job id: `$ARGUMENTS` (empty: pick one as in step 1).

## 1. Which job

With no id, run with the Bash tool:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js board --json
```

Keep the rows whose `state` is `awaiting_review` (any `kind` but `subagent` and `session`). None: say "No kimi job
awaits review." and stop. One: use it. Several: ask with AskUserQuestion, header "Job", one option per job, newest
first, at most four (label: the id; description: the title and the verdict).

## 2. Show it

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js review <id>
```

Show the review to the user as it is. Its `Next` section names the right step for the verdict. If the user wants the
diff itself, run it again with `--diff`.

## 3. Ask what to do

If the user's own message already said what to do with this job, do that and skip the question. Otherwise ask with
AskUserQuestion, header "Decision", "What should happen to job <id>?", these options in this order:

- verdict `pass` on an `edit` job: `Accept` (commits the change on the current branch), `Return with feedback`,
  `Discard`, `Leave it`.
- verdict `pass` on a `readonly` or `exec` job: `Close` (records the answer; nothing to merge), `Return with a
  follow-up`, `Discard`, `Leave it`.
- verdict `worker_error`, `quota` or `timeout` (the worker never finished): `Return to try again`, `Discard`,
  `Leave it`. Never offer accept. For `quota`, say first that the account needs topping up at the page the review names.
- any other verdict: `Return with feedback`, `Discard`, `Accept anyway`, `Leave it`.

## 4. Do it

- `Accept` or `Close`: `sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js accept <id>`; `Accept anyway`: the same with `--force`.
- `Return …`: the feedback is what the user wrote (the question's free-text answer, or ask for it in one line); for a
  failing verdict with no words from the user, name the failing gates and their first error lines. Run
  `sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js return <id> '<feedback>'` with the feedback in single quotes (each `'` written as `'\''`).
- `Discard`: `sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js discard <id> --reason '<why>'` when the user gave a reason, else without `--reason`.
- `Leave it`: run nothing.

Show the command's one line; write anything you add yourself as a short title and bullet points, the action first.
If an accept exits 5 with a conflict, nothing was applied: the worker cannot rebase, so
offer once (AskUserQuestion: `Discard`, `Leave it`) to discard it, and say the brief should run again on the current
branch. If it exits 5 because the working tree has uncommitted changes, say to commit or stash them and run
`/kimi:review <id>` again.
