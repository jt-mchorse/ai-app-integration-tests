/**
 * waitFor's deadline honours a timeoutMs above Node's setTimeout limit (#167).
 *
 * #157 raced an async predicate against `setTimeout(..., remaining)`. Node
 * clamps any delay above 2**31-1 ms (`MAX_TIMER_MS`) to 1 ms, and `timeoutMs`
 * is only validated as finite, so `timeoutMs: Number.MAX_SAFE_INTEGER` fired
 * the deadline after 1 ms: a 20 ms predicate threw "timed out after 1ms".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_TIMER_MS } from "../src/support/retry-budget.js";
import { waitFor, WaitTimeoutError } from "../src/support/wait-for.js";

const slowOk = (): Promise<string> =>
  new Promise((resolve) => setTimeout(() => resolve("ok"), 20));

describe("waitFor deadline above the setTimeout limit (#167)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const timeoutMs of [MAX_TIMER_MS + 1, Number.MAX_SAFE_INTEGER]) {
    it(`a 20 ms async predicate returns its value at timeoutMs=${timeoutMs}`, async () => {
      await expect(waitFor(slowOk, { timeoutMs, intervalMs: 10 })).resolves.toBe("ok");
    });
  }

  it("the control: at exactly MAX_TIMER_MS the predicate already wins", async () => {
    await expect(
      waitFor(slowOk, { timeoutMs: MAX_TIMER_MS, intervalMs: 10 }),
    ).resolves.toBe("ok");
  });

  it("a never-settling predicate times out at the full deadline, not one timer-limit in", async () => {
    vi.useFakeTimers();
    const timeoutMs = MAX_TIMER_MS + 5_000;
    let settled: unknown = "pending";
    const p = waitFor(() => new Promise<string>(() => {}), {
      timeoutMs,
      intervalMs: 10,
      label: "beyond-the-limit",
    }).then(
      (v) => (settled = v),
      (e: unknown) => (settled = e),
    );

    // One full timer-limit chunk elapses: the re-armed deadline is still pending.
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS + 1);
    expect(settled).toBe("pending");

    // The rest of the budget elapses: now it times out, with the label.
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(settled).toBeInstanceOf(WaitTimeoutError);
    expect((settled as WaitTimeoutError).label).toBe("beyond-the-limit");
    expect((settled as WaitTimeoutError).elapsedMs).toBeGreaterThanOrEqual(timeoutMs);
  });
});
