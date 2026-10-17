import { existsSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { goldenTranscript } from "./golden-flow.ts";

// The oracle for behaviour-preserving refactors: every user-visible string of a scripted session, byte for byte. A
// change here is a change users see; review the diff of zai.transcript.txt like any other output change.
// The provider-agnostic and worker-terms legs this file once carried (the same session as a second provider, under
// another worker's terms) are covered on the Go side: internal/render/provider_test.go (every renderer, fed a second
// provider, takes every name from it and none of zai's), internal/cli/commands_test.go TestCommandsSecondProvider
// and internal/app/worker_neutral_test.go (the engine drives a worker that is not claude), and
// internal/domain/provider_test.go (the brief template under another worker's terms).
describe("golden transcript (plugin-core binary, fake claude, pinned clock and ids)", () => {
  it("prints exactly what it printed before", async () => {
    // A missing file would pass (and -u would write it): the golden must already be there.
    expect(existsSync(new URL("golden/zai.transcript.txt", import.meta.url))).toBe(true);
    await expect(await goldenTranscript()).toMatchFileSnapshot("golden/zai.transcript.txt");
  }, 120_000);
});
