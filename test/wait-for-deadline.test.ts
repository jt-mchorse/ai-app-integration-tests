/**
 * The waitFor deadline bounds a pending predicate, not only the sleeps (#157).
 *
 * `waitFor` awaited `predicate()` with nothing racing it: a predicate that
 * never settled (Playwright's `textContent()` waiting for an element that
 * never appears -- the documented example) never reached `WaitTimeoutError`,
 * and a slow one overshot the deadline by its own duration (400 ms per call
 * against a 500 ms budget rejected at ~857 ms).
 */
import { describe, expect, it } from "vitest";

import { waitFor, WaitTimeoutError } from "../src/support/wait-for.js";

describe("waitFor deadline vs a pending predicate (#157)", () => {
  it("a predicate that never settles times out at the deadline, with the label", async () => {
    const started = Date.now();
    const err = await waitFor(() => new Promise<string>(() => {}), {
      timeoutMs: 300,
      intervalMs: 50,
      label: "never-appears",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaitTimeoutError);
    expect((err as WaitTimeoutError).label).toBe("never-appears");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("carries the value of the last poll that did settle", async () => {
    let calls = 0;
    const err = await waitFor(
      // A falsy first poll (truthy would end the wait), then one that hangs.
      () => (++calls === 1 ? Promise.resolve(0) : new Promise<number>(() => {})),
      { timeoutMs: 300, intervalMs: 20 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaitTimeoutError);
    expect((err as WaitTimeoutError).lastValue).toBe(0);
    expect(calls).toBe(2);
  });

  it("a slow predicate does not overshoot the deadline by its own duration", async () => {
    const started = Date.now();
    const err = await waitFor(
      () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 400)),
      { timeoutMs: 500, intervalMs: 50 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaitTimeoutError);
    expect(Date.now() - started).toBeLessThan(700);
  });

  it("a predicate that rejects after the timeout is not an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const err = await waitFor(
        () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), 150)),
        { timeoutMs: 50, intervalMs: 10 },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WaitTimeoutError);
      await new Promise((r) => setTimeout(r, 250));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a predicate that resolves in time still wins", async () => {
    const value = await waitFor(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("ready"), 30)),
      { timeoutMs: 1_000, intervalMs: 10 },
    );
    expect(value).toBe("ready");
  });
});
