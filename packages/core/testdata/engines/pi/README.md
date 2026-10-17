# pi RPC fixtures

Recordings of `pi --mode rpc` (pi 1.0.4) traffic, one directory per scenario, replayed by
[`fake-pi.ts`](../fake-pi.ts) in lockstep with the commands the client sends. They are hand-written
against the wire shapes the real binary was probed with (no live key was ever involved), which is what
`synthetic: true` in each `meta.json` records.

Each directory holds `interleaved.jsonl` (the whole exchange in order, `{"dir": "out"|"in", "t", "bytes",
"frame"}`, one JSON object per line), `stdout.jsonl` and `stdin.jsonl` (the two sides split out),
`stderr.txt` (written out before any frame) and `meta.json`. Ids in the recordings are remapped to
whatever the client sends; `abort-mid-run` and `hang-mid-tool` stop at their `in` entries until the
matching command actually arrives.

| fixture | probe | what it shows |
| --- | --- | --- |
| [success-readonly](success-readonly/) | P1 | A readonly turn end to end: get_state, an admitted prompt, a find tool call and result, then the final assistant text and settle. |
| [error-after-success](error-after-success/) | P2 | pi admits the prompt (success response) and the failure arrives on the message stream instead: an assistant message that ends stopReason error with the provider's 401 body. |
| [abort-mid-run](abort-mid-run/) | P3 | An abort mid-tool: pi cancels the running tool, closes the aborted assistant message in a turn of its own, settles, and answers the abort response last. |
| [resume-turn2](resume-turn2/) | P4 | A second turn in a resumed session (--session-id): get_state reports messageCount 4 and the turn starts without the system message again. |
| [hang-mid-tool](hang-mid-tool/) | P5 | A tool that never finishes: replay stops at tool_execution_start and only the abort lets the rest out — the wall clock fires first. |
| [malformed-line](malformed-line/) | P6 | A stray line mid-stream: something that is not JSON lands between frames, is logged and skipped, and the turn still settles. |
