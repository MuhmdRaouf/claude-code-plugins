import { describe, expect, it } from "vitest";
import { followJob } from "../../src/app/follow.ts";
import { FOLLOW } from "../../src/domain/follow.ts";
import { aJob, anAttempt } from "../support/builders.ts";
import { type Fakes, fakeDeps, T0 } from "../support/fakes.ts";

/** Records every poll interval; `onSleep(n)` runs before the n-th sleep (1-based). */
function recordSleeps(fakes: Fakes, onSleep: (n: number) => void = () => {}): number[] {
  const slept: number[] = [];
  const sleep = fakes.clock.sleep.bind(fakes.clock);
  fakes.deps.clock.sleep = async (ms, signal) => {
    slept.push(ms);
    onSleep(slept.length);
    await sleep(ms, signal);
  };
  return slept;
}

const never = new AbortController().signal;

describe("followJob", () => {
  it("polls with backoff while a live driver works the job and returns the job once it lands", async () => {
    const fakes = fakeDeps();
    const job = fakes.store.put(aJob({ id: "j1", state: "running", attempts: [anAttempt()] }));
    fakes.store.holdLock("j1", process.pid);
    const slept = recordSleeps(fakes, (n) => {
      if (n === 5) fakes.store.put({ ...job, state: "awaiting_review" });
    });

    const followed = await followJob(fakes.deps, "j1", never);

    expect(followed).toMatchObject({
      ok: true,
      value: { kind: "landed", job: { state: "awaiting_review" } },
    });
    expect(slept).toEqual([1000, 2000, 4000, 5000, 5000]);
  });

  it("a decided job lands at once, without a single poll", async () => {
    const fakes = fakeDeps();
    fakes.store.put(aJob({ id: "j1", state: "accepted" }));
    const slept = recordSleeps(fakes);

    expect(await followJob(fakes.deps, "j1", never)).toMatchObject({ value: { kind: "landed" } });
    expect(slept).toEqual([]);
  });

  it("a running job whose driver died is stale", async () => {
    const fakes = fakeDeps();
    fakes.store.put(aJob({ id: "j1", state: "running", attempts: [anAttempt()] }));
    fakes.store.holdLock("j1", 99_999);

    expect(await followJob(fakes.deps, "j1", never)).toMatchObject({
      ok: true,
      value: { kind: "stale", job: { id: "j1", state: "running" } },
    });
  });

  it("the driver dying mid-job turns the follow stale on the next poll", async () => {
    const fakes = fakeDeps();
    fakes.store.put(aJob({ id: "j1", state: "running", attempts: [anAttempt()] }));
    fakes.store.holdLock("j1", 4242);
    fakes.process.alive.add(4242);
    recordSleeps(fakes, (n) => {
      if (n === 2) fakes.process.alive.delete(4242);
    });

    expect(await followJob(fakes.deps, "j1", never)).toMatchObject({ value: { kind: "stale" } });
  });

  it("a queued job waits for its driver to claim it, and is stale once nobody has for the grace period", async () => {
    const fakes = fakeDeps();
    fakes.store.put(aJob({ id: "j1", state: "queued" }));
    recordSleeps(fakes);

    expect(await followJob(fakes.deps, "j1", never)).toMatchObject({ value: { kind: "stale" } });
    expect(fakes.clock.now() - T0).toBeGreaterThanOrEqual(FOLLOW.unclaimedGraceMs);
    expect(fakes.clock.now() - T0).toBeLessThan(FOLLOW.unclaimedGraceMs + FOLLOW.maxPollMs);
  });

  it("a queued job claimed by a driver within the grace period is followed to review", async () => {
    const fakes = fakeDeps();
    const job = fakes.store.put(aJob({ id: "j1", state: "queued" }));
    recordSleeps(fakes, (n) => {
      if (n === 3) fakes.store.holdLock("j1", process.pid);
      if (n === 12) fakes.store.put({ ...job, state: "awaiting_review" });
    });

    expect(await followJob(fakes.deps, "j1", never)).toMatchObject({ value: { kind: "landed" } });
  });

  it("an aborted follow detaches and leaves the job alone", async () => {
    const fakes = fakeDeps();
    const job = fakes.store.put(aJob({ id: "j1", state: "running", attempts: [anAttempt()] }));
    fakes.store.holdLock("j1", process.pid);
    const controller = new AbortController();
    recordSleeps(fakes, (n) => {
      if (n === 2) controller.abort();
    });

    expect(await followJob(fakes.deps, "j1", controller.signal)).toMatchObject({
      ok: true,
      value: { kind: "detached", job: { id: "j1", state: "running" } },
    });
    expect(fakes.store.jobs.get("j1")).toEqual(job);
    expect(fakes.process.terminated).toEqual([]);
  });

  it("an abort before the first poll still reads the job once and detaches", async () => {
    const fakes = fakeDeps();
    fakes.store.put(aJob({ id: "j1", state: "running", attempts: [anAttempt()] }));
    fakes.store.holdLock("j1", process.pid);
    const controller = new AbortController();
    controller.abort();

    expect(await followJob(fakes.deps, "j1", controller.signal)).toMatchObject({
      value: { kind: "detached" },
    });
  });

  it("an unknown id is a store not_found error; a failing sleep that was not an abort propagates", async () => {
    const fakes = fakeDeps();

    expect(await followJob(fakes.deps, "nope", never)).toEqual({
      ok: false,
      error: { kind: "store", error: { kind: "not_found", id: "nope" } },
    });

    fakes.store.put(aJob({ id: "j1", state: "running", attempts: [anAttempt()] }));
    fakes.store.holdLock("j1", process.pid);
    fakes.deps.clock.sleep = async () => {
      throw new Error("clock broke");
    };
    await expect(followJob(fakes.deps, "j1", never)).rejects.toThrow("clock broke");
  });
});
