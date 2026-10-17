import { join } from "node:path";

/** The shared executable stand-in for `claude` (support/fake-claude.ts, run through its node shebang), for plugins
 *  that keep no copy of their own. */
export const FAKE_CLAUDE = join(import.meta.dirname, "fake-claude.ts");
