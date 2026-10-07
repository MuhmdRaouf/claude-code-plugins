# omp RPC fixtures (omp 18.6.1, captured 2026-10-06)

Recorded live with a set of probe scripts (not part of this repository). The
probes ran with the client's event filter, which lists `message_update`, so every turn carries its deltas. The
files were then trimmed for the repo (each `meta.json` says how): `get_state`
`systemPrompt` bodies are elided (the `<file path=…>` tags stay), `available_commands_update` keeps two commands,
tool-result fields over 64 KB are cut as the attempt log cuts them, and `rpc-chunk` keeps only its first and last
chunk, with `data` replaced by its length. Full-size chunked frames come from fake-omp's `big-frame` scenario.

Each directory: `stdout.jsonl` (stdout frames as emitted, redacted; rpc_chunk re-encoded after redaction), `stdin.jsonl` (every host line), `interleaved.jsonl` (`{dir,t,bytes,frame}`, chunked frames shown reassembled with `chunked:true`), `stderr.txt`, `meta.json` (argv, exit, timings, `synthetic`). Paths are `<root>`/`<home>`; `credentialId`, `responseId` and credential_pin hashes are dropped.

| fixture | probe | what it shows |
|---|---|---|
| `success-edit` | P1 | edit task on glm-5.3-flash: read, edit, bash, submit_report (essential), stop; stats before/after |
| `success-edit-glm` | P1 | same edit task on zai/glm-5.3 (edit tool uses the hashline `input` form, no args.path) |
| `success-readonly` | P8 | readonly tools, glm-5.3, one-word answer, no tool calls; one of 16 concurrent workers (no 429) |
| `report-invalid-retry` | P2 | schema-invalid submit_report is rejected by omp itself (no host_tool_call); model retries in-turn |
| `report-host-reject-retry` | P2 | omp rejects minLength; then the host rejects a schema-valid report with isError; model retries; third call accepted |
| `readonly-write-attempt` | P3 | read,grep,glob only; asked to write: no write tool exists, model reports blocked; read isError (tool-error); omp rejects a report missing files |
| `resume-turn1` | P4 | turn 1 of the resume pair: stores a codeword |
| `resume-open-session` | P4 | new process, same --session-dir, open_session -> resumed:true, same sessionId, codeword recalled |
| `resume-flag` | P4 | --session-dir D --resume <id> at spawn: get_state shows the same sessionId, messageCount 4 |
| `resume-missing` | P4 | open_session on an empty dir -> resumed:false (fresh session) |
| `resume-unknown-id` | P4 | --resume <unknown id>: no ready frame, exit 1, stderr 'Session "…" not found.' |
| `abort-mid-tool` | P5 | RPC abort during bash sleep: [Command cancelled], assistant stopReason aborted, prompt_result aborted in ~0.3 s; then SIGTERM idle -> 143 |
| `sigterm-mid-tool` | P5 | SIGTERM to the process group during bash: no further frames, exit 143 |
| `max-time-expiry` | P6 | --max-time 15s in RPC: bash [Command cancelled], prompt_result completed, last assistant stopReason toolUse, process stays up, exit 0 on stdin close |
| `not-authenticated` | P7 | empty PI_CODING_AGENT_DIR, no ZAI_API_KEY: ready+get_state fine; the prompt gets two responses (success, then success:false with the error); prompt_result status error, agentInvoked false, 'No API key found for zai', no session_settled |
| `provider-error-401` | P7 | bogus key: assistant stopReason error, prompt_result error httpStatus 401 retryable false, no auto_retry |
| `big-frame` | P9 | host RPC bash with 3 MB output (column-truncated to 768) and a model read of a 3 MB file: 519 KB tool_execution_end/message_end frames, no chunking |
| `text-delta` | P10 | design filter + message_update (delta): text_start/text_delta/text_end frames; no thinking deltas at --thinking low |
| `rpc-chunk` | P9 | protocol v2: a get_entries response of 1.17 MB arrives as 5 rpc_chunk frames (256 KiB slices, chunkId `rpc-1`, no `id`) |
| `rate-limited-429.SYNTHETIC` | P8 | **SYNTHETIC.** `success-readonly` with two 429 failures, `auto_retry_start` ×2 and `auto_retry_end` spliced in from documented shapes (`meta.json` lists the spliced line indexes). No real 429 could be provoked |

Extra files: `not-authenticated/omp-models-zai.empty-profile.json` (exact stdout, exit 0: `{"models":[]}`) and `not-authenticated/omp-models-zai.user-profile.trimmed.json` (logged-in profile, trimmed to the two GLM-5.3 entries).
