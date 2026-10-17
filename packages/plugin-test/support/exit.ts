/**
 * The CLI's fixed exit codes, the contract every provider plugin's binary answers with (the plugin-core CLI; the
 * repository's AGENTS.md documents them).
 */
export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  notPass: 3,
  notFound: 4,
  conflict: 5,
  notReady: 6,
  /** SIGINT/SIGTERM ended a follower (128 + SIGINT); the job keeps running. */
  interrupted: 130,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
