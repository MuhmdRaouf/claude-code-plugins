<!-- generated from plugin/skills/huddle/SKILL.md by bun run connect: edit the skill -->
# Huddle: many sessions, one team

Huddle keeps one **channel** per piece of shared work.

- Every session in a channel, whatever project it runs in, and every subagent it starts, sees the
  same events, plan, pause switches and knowledge.
- The server is the single source of truth; nothing is shared through files or guesses.
- It runs at http://127.0.0.1:<port>: a random five-digit port per project that `huddle up` picks,
  saves and shows.
- Set it up with `/huddle:setup`, start it with `huddle up`, see the address with `huddle server`.

You reach it two ways, with the same operations:

| From | How | Who |
|---|---|---|
| MCP tools `mcp__plugin_huddle_huddle__<op>` | plugin `huddle` (stdio bridge; env `HUDDLE_CHANNEL`, `HUDDLE_AS`) | a main session, foreground subagents |
| `huddle <op>` in Bash | `huddle` (the session start puts it on PATH; Bun, else Node; same env) | anyone with Bash: background subagents, scripts |

**Joining.**

- Being in a huddle takes a credential, kept for the session and for its project. The next
  session in a project that joined is in too, and a server restart keeps every member in.
- The session that started the server holds the root credential.
- Another project joins once with an invite: the user runs `/huddle:invite` in a session that is
  in and pastes the join line it prints into the other session
  (`/huddle:join <host:port> --token …`).
- The creator also has `huddle token list`, `token delete <id>`, `members` and `kick <name>`.
- A session without a credential is outside: say so and tell the user the way back in.
- Never put a credential in a message, knowledge or a file.

Your name is `HUDDLE_AS` (e.g. `api`). A subagent is `<parent>.<role>` (e.g. `api.explore`).
Both usually come from `.agents/huddle/huddle.json` in your repo (`{"channel": "shop", "as": "api"}`);
`HUDDLE_*` env vars override it.

## The loop (do this, in this order)

1. **You are already in.** The SessionStart hook joined a main session and put the picture in
   your context; call `status` to refresh it (call `join` again only to change your role or
   context: it resets your presence). Read it: inbox, unread events or a brief (see "Fresh
   context or sync"), next task, the latest knowledge, who holds the turn, who the orchestrator
   is, whether you are paused. A subagent joins itself (see below).
2. **Recall before you read.** `recall` with 2–4 words before opening files, searching the repo
   or re-deriving anything. Read a hit in full with `kb <id>`. A hit is cheaper than a re-read.
   Verified entries come first; a hit marked "may be stale" (old, or its files changed) is a
   lead to check, not a fact: once checked, `verify <id>` it, or `remember` the fix with `supersedes`.
3. **Gate before you change anything.** `gate` blocks while you are paused (the owner or another
   session pauses you; publishing, task changes and turn moves are then refused with 423, while
   messages and replies still go through). Never work around a pause.
4. **Answer the inbox first.** Every `ask` (and owner directive) waits for your `reply`; it keeps
   waking your `wait` until you do. Reply even if only "on it, done by X".
5. **Work the plan.** `start` takes your next task (yours or unowned; or the id you name), marks it
   `doing` and returns its text with the owner's notes, which override it → do it →
   `finish "<command + result>"` marks it done and names your next. `start` refuses a task that
   still waits on unfinished ones and says on which: then `wait` with `["task.ready"]`.
6. **Remember what others would need.** After learning something non-obvious, `remember` it
   (see below). After finishing a task, `remember` a `result` if its output feeds another task.
7. **Hand over, then listen.** When your part is done or you are blocked on someone:
   publish/pass/send what they need, then `wait` (below). Do not end your turn silently while
   another session waits on you.

## Fresh context or sync

`join` takes `context`:

- **sync**: every event since you last acked, oldest first, asks first. Right when your work
  depends on what happened while you were away: a handoff to you, a review, answering a thread.
- **fresh**: the backlog is skipped (the answer says how many events) and you get a **brief**
  instead: the channel's goal, the orchestrator's brief for you, your own open tasks with what
  they wait on, the five knowledge entries nearest to your role and task, and every open ask
  (asks are never skipped). Right for a new independent task, a context that is polluted or
  very long, and right after a compaction.

Who decides: the orchestrator (`assign <session> context`, and `brief` for what you get next
time). Without a setting, a first join and a subagent are fresh and a return is sync. You may
ask for either yourself: `join` with `context`, `huddle join --fresh` or `--sync`. The plugin's
SessionStart hook joins sync after a resume and fresh after `/clear` or a compaction
(`HUDDLE_CONTEXT` or `context` in `.agents/huddle/huddle.json` overrides it).

Do not read the whole plan by default: `next` and `start` give you your slice. Call `map` when
you need the big picture (phases, who does what, the critical path).

## The orchestrator

A channel can name one session its **orchestrator** (the owner sets `orchestrator` with
`configure`). It runs the plan with the owner: `import_plan` (merged by task id; status, edits
and notes are kept), `task_create` for single tasks, `approve`, `note_edit`, `configure` (not
`members` or `orchestrator`), `assign` and `brief`. Anyone else gets 403 for those. Every plan
change emits `task.*` events, so each session hears about its own tasks.

## Workflows: one call instead of four

Reach for these first; each one does the bookkeeping the loop above describes.

| Op (MCP) | CLI | What it does |
|---|---|---|
| `start` | `huddle start [id]` | checks the pause, takes the task (or your next one), marks it `doing`, returns its full text; if it still waits on other tasks it says on which and does not start |
| `finish` | `huddle finish "<evidence>" [--result "<output>"]` | marks your current task `done` with the evidence, stores `result` as knowledge, returns what it released and your next task |
| `depend` | `huddle depend <session> "<what they must do>"` | creates a task for that session, makes yours wait on it, marks yours `blocked`, then sleeps until `task.ready` |
| `handoff` | `huddle handoff <session> "<what next>" [--title t]` | optionally creates a task for them, passes the turn with your message, then waits for your next wake-up |
| `ask_wait` | `huddle ask <session> "<question>"` | asks and blocks until they reply; the answer is the result |

## Waiting on someone else (instead of polling or guessing)

- **On a task:** your task depends on another session's (`after`). Call `wait` with topics
  `["task.ready"]`, or `wait_task <id>` for one specific task. Huddle sends `task.ready` to the
  owner of a task the moment everything it waits on is done or skipped.
- **On an event:** `wait` with topic globs, e.g. `["build.*","review.done","turn.pass"]`.
- `wait` returns `kind`:
  - `message` → an ask for you: handle it, `reply`, wait again;
  - `event` → handle it **and its `skipped` list** (unread events before it), then `ack <seq>`;
  - `timeout` → call `wait` again. Do not pass `timeout` yourself: the default already waits
    as long as the transport allows (about 25 minutes through the plugin), and each short wait
    costs you a turn.
- `ack` only after handling: delivery is at-least-once; make handlers safe to repeat. A
  `publish` with `key` is idempotent.
- With pushes on (`claude --dangerously-load-development-channels server:plugin:huddle:huddle`), a
  `<channel source="huddle">` message can wake you while idle: treat it exactly like a `wait`
  result, then `ack`.
- You hear everything: messages between other sessions reach you too, in `wait`'s skipped
  list, in pushes and, through the plugin, in your context after each tool call ("overheard").
  Use them as knowledge; answer only what is addressed to you or to everyone. A bash agent can
  follow the channel with `huddle listen` (one JSON line per event).

## Working together

- **In parallel** (no turn holder): each session takes tasks it owns; dependencies order them.
- **Ping-pong** (channel `start` + `handover` configured): only the turn holder acts. Publishing
  a handover topic passes the turn; `pass <to> "<what next>"` passes it explicitly; `turn` shows
  who holds it. Off turn: listen, answer asks, prepare, but do not change shared things.
- **Ask another session for work:** `task_create` with `owner` (and `after` if it must wait on
  something). They get `task.created` now and `task.ready` when it can start. For a question,
  `send` with `ask=true`.
- **Stop someone:** `pause <session> "<why>"` (e.g. they are about to touch what you are
  changing); `resume` when safe. Tell them why; they see it in their timeline.
- **Never** edit another session's repo or files to "help": create a task for it or send it.
- **Same file, two sessions:** when you edit a file another session edited in the last 30
  minutes, one line in your context says who ("payments edited src/cart.ts 4 min ago").
  Nothing is locked: `send` it (or `ask`) what it is changing before you go on.

## Subagents in the channel

When you start a subagent for shared work, make it a channel member so its results reach
everyone (and you do not have to paste them back):

1. Before starting it: `join` with `as: "<you>.<role>"` (MCP) or
   `HUDDLE_AS=<you>.<role> huddle join --role "<one line>"` (Bash).
2. In its prompt, say: *you are `<you>.<role>` in Huddle channel `<channel>`; use `huddle` from
   Bash with `HUDDLE_CHANNEL=<channel> HUDDLE_AS=<you>.<role>`; `recall` first; `remember` your
   findings (kind `context` or `result`, with refs); `leave "<summary>"` when done.*
   The `huddle-worker` agent in this plugin already follows this.
3. Read its `remember` entries instead of re-reading its transcript.

A subagent joins fresh: it starts at the channel's present (no backlog) with a brief. Only its
parent may act as it.

## What to remember (and what not)

| kind | when | example title |
|---|---|---|
| `fact` | true about the code/system, costly to find | "Orders are soft-deleted: every query filters deleted_at" |
| `lesson` | a mistake not to repeat | "The test DB is shared: run migrations with --lock" |
| `decision` | chosen, with why and the options turned down | "Cursor pagination, not offsets: lists grow while paging" |
| `context` | a summary of files/state you read (paths in refs) | "How the checkout service talks to payments" |
| `result` | the output of finished work another task needs | "API v2 deployed to staging: endpoints to re-test" |
| `howto` | a command sequence that works | "Reset the local database with seed data" |

Title: one searchable line. Body: the answer first, then evidence; ≤ 40 lines; link the rest in
`refs` (a file in `refs` that changes later marks the entry "may be stale"). Before adding,
`recall` it; if an entry already says the same, `remember` adds nothing and names it: supersede
it, `verify` it, or pass `force` if yours is really different. If an entry is wrong or stale,
`remember` the fix with `supersedes`. A lesson that holds in every project (a tool quirk, a fact
about this machine): `scope: "server"`, or `share <id>` an existing one; every channel recalls
it. `huddle knowledge export [--verified]` prints the knowledge as Markdown for a CLAUDE.md.
Never store secrets.

## Etiquette that keeps a channel sane

- Presence: `state` with a short task when you switch work (`working`, `waiting`, `blocked`).
- One event per meaningful fact; put details in the ref file or the knowledge store, not in
  chatty messages.
- Evidence, not claims: `done` notes carry the command and its result.
- If Huddle is unreachable, treat yourself as paused for shared work, tell the owner, retry.
  The CLI exits 5 in that case; `huddle gate` keeps retrying (fail closed).
- Reports to the user: a short title and bullet points, the action or answer first. No preamble
  or recap.

## Quick reference

`join` `status` `sessions` `state` · `publish` `send` `reply` `inbox` `events` · `wait` `ack`
`gate` `pause` `resume` · `turn` `pass` `take` · `next` `map` `task` `tasks` `task_create`
`task_update` `task_status` `wait_task` `note` · `start` `finish` `depend` `handoff` `ask_wait` ·
`remember` `recall` `kb` `verify` `share` · `digest` · `leave` · owner or orchestrator: `import_plan` `configure` `approve`
`note_edit` `assign` `brief`.
CLI: `huddle help`; exit codes 0 ok · 3 message · 4 paused · 5 unreachable · 124 timeout.
