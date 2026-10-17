# opencode event fixtures

Hand-written stdout lines for `opencode run --format json`, following the shapes recorded live from opencode 1.18.34
(one JSON object per line; every event carries `timestamp` as epoch milliseconds and `sessionID`; part events nest
their payload under `part`). Session and part ids and timestamps are scrubbed stand-ins. `fake-opencode.ts` replays
these verbatim; FAKE_OPENCODE_EXIT / FAKE_OPENCODE_HANG / FAKE_OPENCODE_LINE_MS / FAKE_OPENCODE_CHILD_PIDFILE /
FAKE_OPENCODE_RESUME_MISSING shape what happens around them.

- `happy.jsonl` — one step: the text report, then step_finish (the golden run).
- `tool-run.jsonl` — a completed bash call, then a second step with the report (usage summed over both steps).
- `error-event.jsonl` — the stream's own error event mid-run (pair with FAKE_OPENCODE_EXIT=1).
- `no-step-finish.jsonl` — ends with no step_finish at all (pair with FAKE_OPENCODE_HANG=1 for timeout/interrupt).
- `malformed.jsonl` — happy plus lines that are not events: not JSON, no timestamp, a text part with no text.
- `fenced-report.jsonl` / `prose-report.jsonl` / `plain-text.jsonl` — the report in a ```json fence, buried in prose,
  not there at all.
