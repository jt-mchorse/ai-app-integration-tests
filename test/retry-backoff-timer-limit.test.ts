// `withRetryBudget` rejected Infinity for a reason that isn't true (#97).
//
// The `backoffMs` guard's comment said: "NaN -> setTimeout(NaN) coerces to 0
// (silent abandonment of the backoff schedule); Infinity -> setTimeout(Infinity)
// hangs the test." The first half is right. The second half is measurably false,
// and correcting it is what exposes the gap.
//
// Measured on Node v25.5.0:
//
//   setTimeout(Infinity) resolved after 2 ms
//     TimeoutOverflowWarning: Infinity does not fit into a 32-bit signed
//     integer. Timeout duration was set to 1.
//   setTimeout(NaN)      resolved after 1 ms
//
// Node clamps ANY delay above 2**31 - 1 to 1 ms. So `Infinity` has the *same*
// harm as `NaN`, not the opposite one, and rejecting it while accepting every
// other value in `(2147483647, Infinity)` caught one point of an interval that
// has that harm throughout:
//
//   backoffMs=2147483647  -> real sleep 2147483647 ms
//   backoffMs=2147483648  -> real sleep 1 ms  (CLAMPED)
//   backoffMs=3600000000  -> real sleep 1 ms  (CLAMPED)
//   backoffMs=1e308       -> real sleep 1 ms  (CLAMPED)
//
// And the *computed* backoff had the same gap. With ordinary inputs
// (`backoffMs: 1000`, `multiplier: 2`) the schedule collapses partway through:
//
//   attempt 22: backoff  2097152000 ms   (fine)
//   attempt 23: backoff  4194304000 ms   -> clamped to 1 ms
//   attempt 25: backoff 16777216000 ms   -> clamped to 1 ms
//
// The first test below CALLS THE REAL setTimeout rather than trusting the
// paragraph above. The harm is a runtime behaviour of Node's timer, so it has to
// be measured, not described.

import { describe, expect, test, vi } from "vitest";

import { MAX_TIMER_MS, withRetryBudget } from "../src/support/retry-budget.js";

const okFn = async (): Promise<string> => "ok";
const flakyFn = async (): Promise<never> => {
  throw Object.assign(new Error("transient"), { status: 503 });
};

describe("Node's setTimeout clamp is real, not assumed (#97)", () => {
  test("a delay above MAX_TIMER_MS sleeps ~1 ms instead of ~24.8 days", async () => {
    // The premise of this whole issue, measured directly. If a future Node
    // changes this, the guard's rationale changes with it and this test says so.
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const started = Date.now();
      await new Promise<void>((resolve) => setTimeout(resolve, MAX_TIMER_MS + 1));
      const elapsed = Date.now() - started;
      // ~24.8 days would be 2147483648 ms. Anything under a second proves the clamp.
      expect(elapsed).toBeLessThan(1000);
    } finally {
      warn.mockRestore();
    }
  });

  test("MAX_TIMER_MS is exactly the 32-bit signed limit", () => {
    // Named rather than inlined, and pinned so a typo in the constant can't
    // quietly widen or narrow the guard.
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1);
    expect(MAX_TIMER_MS).toBe(2_147_483_647);
  });
});

describe("backoffMs upper bound (#97)", () => {
  test.each([
    { value: 2_147_483_648, label: "MAX_TIMER_MS + 1" },
    { value: 3_600_000_000, label: "an hour expressed in microseconds" },
    { value: 1e308, label: "1e308" },
    { value: Number.MAX_SAFE_INTEGER, label: "MAX_SAFE_INTEGER" },
  ])("rejects backoffMs = $label", async ({ value }) => {
    await expect(
      withRetryBudget(okFn, { maxAttempts: 3, backoffMs: value }),
    ).rejects.toThrow(/backoffMs must be <= 2147483647/);
  });

  test("the rejection message says what the harm is, not just the rule", async () => {
    // An operator who typed a microsecond value needs to know their backoff was
    // about to become 1 ms, not merely that a number was too big.
    await expect(
      withRetryBudget(okFn, { maxAttempts: 3, backoffMs: 3_600_000_000 }),
    ).rejects.toThrow(/silently clamped to 1 ms/);
  });

  test("exactly MAX_TIMER_MS is still accepted", async () => {
    // Inclusive boundary: 2147483647 really does sleep 2147483647 ms, so it is a
    // legal (if eccentric) request. `okFn` never fails, so nothing sleeps.
    await expect(
      withRetryBudget(okFn, { maxAttempts: 1, backoffMs: MAX_TIMER_MS }),
    ).resolves.toBe("ok");
  });
});

describe("the computed schedule is bounded at the boundary, not mid-loop (#97)", () => {
  test("a schedule that would overflow is rejected before fn is called once", async () => {
    // Mid-loop rejection would be worse than the bug: it would turn a flake into
    // a hard failure halfway through a budget the caller committed to. So the
    // check has to happen before any attempt.
    const fn = vi.fn(flakyFn);
    await expect(
      withRetryBudget(fn, { maxAttempts: 26, backoffMs: 1000, backoffMultiplier: 2 }),
    ).rejects.toThrow(/backoff schedule overflows/);
    expect(fn).not.toHaveBeenCalled();
  });

  test("the message names the offending attempt and all three inputs", async () => {
    // With maxAttempts=26 the peak backoff is at attempt 25 (the 26th takes the
    // isLast branch and sleeps 0), exponent 24: 1000 * 2^24 = 16777216000.
    await expect(
      withRetryBudget(flakyFn, { maxAttempts: 26, backoffMs: 1000, backoffMultiplier: 2 }),
    ).rejects.toThrow(/attempt 25 would sleep 16777216000 ms/);
    await expect(
      withRetryBudget(flakyFn, { maxAttempts: 26, backoffMs: 1000, backoffMultiplier: 2 }),
    ).rejects.toThrow(/maxAttempts \(26\).*backoffMs \(1000\).*backoffMultiplier \(2\)/);
  });

  test("a schedule that stays in range is unaffected", async () => {
    // maxAttempts=22 -> peak exponent 20 -> 1000 * 2^20 = 1048576000, in range.
    // Every sleep is observed rather than performed, so this is instant.
    const sleeps: number[] = [];
    await expect(
      withRetryBudget(flakyFn, {
        maxAttempts: 22,
        backoffMs: 1000,
        backoffMultiplier: 2,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow(/retry budget exhausted after 22 attempt\(s\)/);
    // 21 sleeps: the final attempt takes the isLast branch.
    expect(sleeps).toHaveLength(21);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(MAX_TIMER_MS);
    expect(Math.max(...sleeps)).toBe(1000 * 2 ** 20);
  });

  test("the boundary between the two is exact", async () => {
    // 23 attempts -> peak exponent 21 -> 2097152000, in range.
    // 24 attempts -> peak exponent 22 -> 4194304000, over.
    const noSleep = { sleep: async (): Promise<void> => {} };
    await expect(
      withRetryBudget(flakyFn, {
        maxAttempts: 23,
        backoffMs: 1000,
        backoffMultiplier: 2,
        ...noSleep,
      }),
    ).rejects.toThrow(/retry budget exhausted/);
    await expect(
      withRetryBudget(flakyFn, {
        maxAttempts: 24,
        backoffMs: 1000,
        backoffMultiplier: 2,
        ...noSleep,
      }),
    ).rejects.toThrow(/backoff schedule overflows/);
  });

  test("maxAttempts = 1 is unaffected by any in-range backoffMs", async () => {
    // No backoff is ever computed on a single-attempt budget, so there is
    // nothing to bound. Guarding it anyway would reject a perfectly valid policy.
    await expect(
      withRetryBudget(okFn, { maxAttempts: 1, backoffMs: MAX_TIMER_MS, backoffMultiplier: 2 }),
    ).resolves.toBe("ok");
    await expect(
      withRetryBudget(flakyFn, { maxAttempts: 1, backoffMs: MAX_TIMER_MS }),
    ).rejects.toThrow(/retry budget exhausted after 1 attempt\(s\)/);
  });

  test("a shrinking multiplier can never overflow", async () => {
    // multiplier < 1 makes the peak the FIRST backoff, not the last, so a large
    // maxAttempts is fine. The `maxAttempts - 2` exponent handles this because
    // `0.5 ** 98` is tiny, not huge.
    const sleeps: number[] = [];
    await expect(
      withRetryBudget(flakyFn, {
        maxAttempts: 100,
        backoffMs: 1000,
        backoffMultiplier: 0.5,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow(/retry budget exhausted after 100 attempt\(s\)/);
    expect(Math.max(...sleeps)).toBe(1000);
  });
});

describe("what must not change (#97)", () => {
  test("the existing finiteness message is preserved for NaN and Infinity", async () => {
    // `test/support.test.ts` matches on /backoffMs must be a finite number/.
    // The new upper bound is a separate branch with its own message, so both
    // diagnostics stay distinct.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        withRetryBudget(okFn, { maxAttempts: 3, backoffMs: value }),
      ).rejects.toThrow(/backoffMs must be a finite number/);
    }
  });

  test("an ordinary policy behaves exactly as before", async () => {
    const sleeps: number[] = [];
    await expect(
      withRetryBudget(flakyFn, {
        maxAttempts: 3,
        backoffMs: 10,
        backoffMultiplier: 2,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow(/retry budget exhausted after 3 attempt\(s\)/);
    expect(sleeps).toEqual([10, 20]);
  });

  test("a hard error still short-circuits before any schedule concern", async () => {
    const fn = vi.fn(async () => {
      throw new Error("a real bug, not a flake");
    });
    await expect(
      withRetryBudget(fn, { maxAttempts: 5, backoffMs: 10 }),
    ).rejects.toThrow("a real bug, not a flake");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
