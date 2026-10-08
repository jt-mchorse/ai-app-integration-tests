// Time-bounded predicate polling for AI tests.
//
// "Wait until the streamed UI shows the final response" is a common
// failure mode for retry-with-arbitrary-sleep tests: sleep too long and
// the suite drags; sleep too short and CI flakes. `waitFor` is the
// honest-bounded version: poll at a documented interval, give up at a
// documented timeout, and on failure report what the predicate *was*
// returning so debugging starts with a real signal instead of "test
// timed out somewhere."

import { MAX_TIMER_MS } from "./retry-budget.js";

export interface WaitForOptions<T> {
  timeoutMs: number;
  intervalMs: number;
  // Human-readable label for the failure message. Show up in the test
  // report when the wait times out.
  label?: string;
  // Hook for tests; defaults to `setTimeout`-based sleep.
  sleep?: (ms: number) => Promise<void>;
  // Hook for tests; defaults to `Date.now`.
  now?: () => number;
  // Hook to surface why the wait fired. Optional; useful when the
  // predicate is expensive to compute repeatedly and the operator
  // wants to know what the last reading was.
  onPoll?: (info: { elapsedMs: number; value: Awaited<T> | undefined }) => void;
}

export class WaitTimeoutError extends Error {
  elapsedMs: number;
  lastValue: unknown;
  label: string | undefined;
  constructor(label: string | undefined, elapsedMs: number, lastValue: unknown) {
    const labelPart = label ? ` (${label})` : "";
    super(`waitFor${labelPart} timed out after ${elapsedMs}ms; last value: ${stringify(lastValue)}`);
    this.name = "WaitTimeoutError";
    this.elapsedMs = elapsedMs;
    this.lastValue = lastValue;
    this.label = label;
  }
}

function stringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

const DEADLINE: unique symbol = Symbol("waitFor deadline");

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Poll `predicate` every `intervalMs`. Resolves with the *truthy* value
// the predicate returns; rejects with `WaitTimeoutError` if no truthy
// value appears by `timeoutMs`. Falsy values (`false`, `null`,
// `undefined`, `0`, `""`) count as "keep waiting."
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  options: WaitForOptions<T>,
): Promise<Awaited<T>> {
  // Finiteness guards reject NaN and +/-Infinity (which the sign-only checks
  // silently let through pre-#24). NaN makes every comparison false so the
  // polling loop never times out. +Infinity does not hang setTimeout -- Node
  // clamps it, like every delay above 2**31-1 ms, to 1 ms (#97, #167) -- but
  // it makes `elapsed >= timeoutMs` unreachable, so a sync predicate that
  // never turns truthy polls forever.
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new RangeError(
      `timeoutMs must be a finite number >= 0, got ${options.timeoutMs}`,
    );
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new RangeError(
      `intervalMs must be a finite number > 0, got ${options.intervalMs}`,
    );
  }
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const start = now();
  let lastValue: Awaited<T> | undefined;
  // First call happens immediately so the predicate's first observation
  // is at elapsed=0; this matters when the caller computes off-clock.
  while (true) {
    const polled = predicate();
    if (isThenable(polled)) {
      // The deadline covers the predicate too (#157). It used to be awaited
      // with nothing racing it, so a predicate that never settled -- a
      // Playwright `textContent()` still waiting for its element -- never
      // reached `WaitTimeoutError`, and a slow one overshot the deadline by
      // its own duration. The race uses its own timer, not the injectable
      // `sleep`: a test's fake `sleep` advances its fake clock when CALLED, so
      // racing it would spend the whole budget even when the predicate wins.
      //
      // The timer is armed in chunks of at most MAX_TIMER_MS (#167). Node
      // clamps any setTimeout delay above 2**31-1 ms to 1 ms, and `timeoutMs`
      // is only bounded as finite, so `timeoutMs: Number.MAX_SAFE_INTEGER`
      // fired this deadline after 1 ms and every async predicate slower than
      // that threw WaitTimeoutError. Rejecting a large `timeoutMs` instead
      // would break sync predicates, which never arm this timer and honour it.
      const remaining = Math.max(0, options.timeoutMs - (now() - start));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<typeof DEADLINE>((resolve) => {
        const arm = (left: number): void => {
          const chunk = Math.min(left, MAX_TIMER_MS);
          timer = setTimeout(
            () => (left > chunk ? arm(left - chunk) : resolve(DEADLINE)),
            chunk,
          );
        };
        arm(remaining);
      });
      const pending = Promise.resolve(polled);
      pending.catch(() => {}); // a rejection after a timeout is not unhandled
      try {
        const winner = await Promise.race([pending, deadline]);
        if (winner === DEADLINE) {
          throw new WaitTimeoutError(options.label, now() - start, lastValue);
        }
        lastValue = winner as Awaited<T>;
      } finally {
        clearTimeout(timer);
      }
    } else {
      lastValue = polled as Awaited<T>;
    }
    const elapsed = now() - start;
    options.onPoll?.({ elapsedMs: elapsed, value: lastValue });
    if (lastValue) return lastValue;
    if (elapsed >= options.timeoutMs) {
      throw new WaitTimeoutError(options.label, elapsed, lastValue);
    }
    // Don't oversleep past the deadline; cap the interval to whatever
    // budget remains so the timeout fires at the documented moment.
    const remaining = options.timeoutMs - elapsed;
    await sleep(Math.min(options.intervalMs, remaining));
  }
}
