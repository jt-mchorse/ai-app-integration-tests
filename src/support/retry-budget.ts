// Bounded-retry wrapper for tests that touch flaky surfaces.
//
// AI-feature tests fail for two reasons: real bugs (don't retry) and
// transient flakes (do retry, but only a bounded number of times). The
// hardest mistake to debug is the third kind: a real bug masked by a
// silently-unbounded retry. This helper makes the budget explicit and
// surfaces the classification decision to the caller.

export type FlakeClassification = "flake" | "hard";

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier?: number;
  // Caller decides per-error whether retrying is the right move. The
  // default classifier is conservative — see `defaultClassify` below.
  classify?: (err: unknown, attempt: number) => FlakeClassification;
  // Hook for tests; defaults to `setTimeout`-based sleep. Pluggable
  // so unit tests can run synchronously without burning wall-clock.
  sleep?: (ms: number) => Promise<void>;
  // Optional observer for diagnostics. Called after every failed
  // attempt with the error, the attempt number (1-based), the
  // classification, and the backoff that's about to elapse (0 if
  // the budget is exhausted and we're about to rethrow).
  onAttempt?: (info: {
    err: unknown;
    attempt: number;
    classification: FlakeClassification;
    backoffMs: number;
  }) => void;
}

const DEFAULT_BACKOFF_MULTIPLIER = 2.0;

// The largest delay Node's `setTimeout` can represent (a 32-bit signed int of
// milliseconds, ~24.8 days). Anything above it is silently clamped to **1 ms**
// with a `TimeoutOverflowWarning` on stderr — see the `backoffMs` guard in
// `withRetryBudget` for what that costs and why it is checked there (#97).
export const MAX_TIMER_MS = 2_147_483_647;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Default classifier — treats four flake families as retryable:
//   * AbortError, TimeoutError  (network or fetch timeout)
//   * Errors with a numeric `status` field in 429 or 5xx
//   * Errors whose message includes the word "ECONN..." or "fetch failed"
// Everything else is hard. The caller is expected to override when
// their stack has a different convention.
export function defaultClassify(err: unknown): FlakeClassification {
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; message?: unknown; status?: unknown };
    if (typeof e.name === "string") {
      if (e.name === "AbortError" || e.name === "TimeoutError") return "flake";
    }
    if (typeof e.status === "number") {
      if (e.status === 429 || (e.status >= 500 && e.status < 600)) return "flake";
    }
    if (typeof e.message === "string") {
      const m = e.message;
      if (
        m.includes("ECONNRESET") ||
        m.includes("ECONNREFUSED") ||
        m.includes("ETIMEDOUT") ||
        m.includes("ENOTFOUND") ||
        m.toLowerCase().includes("fetch failed")
      ) {
        return "flake";
      }
    }
  }
  return "hard";
}

export class RetryBudgetExhaustedError extends Error {
  attempts: number;
  lastError: unknown;
  constructor(attempts: number, lastError: unknown) {
    const cause = lastError instanceof Error ? lastError.message : String(lastError);
    super(`retry budget exhausted after ${attempts} attempt(s); last error: ${cause}`);
    this.name = "RetryBudgetExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

// Run `fn` under a bounded retry budget. Resolves with `fn`'s value on
// the first success; otherwise rethrows either the hard error (early
// exit on a non-flake) or a `RetryBudgetExhaustedError` carrying the
// last flaky error after the budget is spent.
export async function withRetryBudget<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  // Integer-and-finite guard. Pre-#24 the `< 1` check accepted NaN (NaN < 1
  // is false), so the for-loop `attempt <= NaN` was always false → loop
  // never ran → RetryBudgetExhaustedError(NaN, undefined). Also accepted
  // fractional `maxAttempts` which silently truncated via the integer
  // attempt counter.
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError(
      `maxAttempts must be an integer >= 1, got ${policy.maxAttempts}`,
    );
  }
  // Finiteness guard. Pre-#24 NaN and Infinity passed: NaN → Math.pow(NaN,…)
  // = NaN → setTimeout(NaN) coerces to 0 (silent abandonment of the backoff
  // schedule).
  //
  // This comment used to continue "Infinity → setTimeout(Infinity) hangs the
  // test." That is measurably false (#97) — Node clamps ANY delay above
  // `MAX_TIMER_MS` to 1 ms and warns on stderr:
  //
  //   setTimeout(Infinity) resolved after 2 ms
  //     TimeoutOverflowWarning: Infinity does not fit into a 32-bit signed
  //     integer. Timeout duration was set to 1.
  //
  // So `Infinity` has the SAME harm as `NaN`, not the opposite one, and
  // rejecting it while accepting every other value in `(MAX_TIMER_MS, ∞)` was
  // catching one point of an interval that has that harm throughout. Hence the
  // upper bound below. Getting the reason wrong is what let the interval
  // survive; the corrected reason is the whole fix.
  if (!Number.isFinite(policy.backoffMs) || policy.backoffMs < 0) {
    throw new RangeError(
      `backoffMs must be a finite number >= 0, got ${policy.backoffMs}`,
    );
  }
  // Measured: 2147483647 sleeps 2147483647 ms, 2147483648 sleeps 1 ms,
  // 3600000000 sleeps 1 ms, 1e308 sleeps 1 ms. The budget still bounds the
  // attempt *count*, but the pacing that makes retrying meaningful is gone and
  // a genuinely-broken upstream gets hammered `maxAttempts` times in a few
  // milliseconds — the retry-side version of the "real bug masked by a
  // silently-unbounded retry" this module's opening comment exists to prevent.
  if (policy.backoffMs > MAX_TIMER_MS) {
    throw new RangeError(
      `backoffMs must be <= ${MAX_TIMER_MS} (Node's setTimeout limit), got ${policy.backoffMs}; ` +
        `a larger delay is silently clamped to 1 ms, abandoning the backoff schedule`,
    );
  }
  // Only validate user-supplied values — undefined still resolves to the
  // 2.0 default below. A non-positive multiplier produces 0 or alternating-
  // sign / NaN backoffs (Math.pow with a non-positive base on a fractional
  // exponent is NaN), which then poison the sleep() call. NaN and +Infinity
  // poison Math.pow the same way and were silently accepted pre-#24.
  // Catching it here surfaces the bug at the boundary instead of mid-loop.
  if (
    policy.backoffMultiplier !== undefined &&
    (!Number.isFinite(policy.backoffMultiplier) || policy.backoffMultiplier <= 0)
  ) {
    throw new RangeError(
      `backoffMultiplier must be a finite number > 0, got ${policy.backoffMultiplier}`,
    );
  }
  const classify = policy.classify ?? defaultClassify;
  const sleep = policy.sleep ?? defaultSleep;
  const multiplier = policy.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;

  // The value that actually reaches `setTimeout` is
  // `backoffMs * multiplier ** (attempt - 1)`, derived from all three validated
  // inputs and — until #97 — checked by none of them. With entirely ordinary
  // inputs (`backoffMs: 1000`, `multiplier: 2`) the schedule collapses partway
  // through:
  //
  //   attempt 22: backoff  2097152000 ms   (fine)
  //   attempt 23: backoff  4194304000 ms   -> clamped to 1 ms
  //   attempt 25: backoff 16777216000 ms   -> clamped to 1 ms
  //
  // i.e. an exponential schedule silently becomes a tight loop past attempt 22.
  //
  // Checked HERE rather than in the loop, on purpose. Each guard above says it
  // exists to "surface the bug at the boundary instead of mid-loop", and
  // rejecting mid-retry would be actively worse: it would turn a flake into a
  // hard failure halfway through a budget the caller had already committed to.
  // The largest backoff a policy can produce is at `attempt = maxAttempts - 1`
  // (the final attempt takes the `isLast` branch and sleeps 0), so the peak
  // exponent is `maxAttempts - 2`. With `maxAttempts <= 1` no backoff is ever
  // computed and there is nothing to bound.
  //
  // NOT clamped to `MAX_TIMER_MS` instead of rejected: that would silently
  // change the schedule the caller asked for, which is the same class of silent
  // degradation this guard is closing.
  if (policy.maxAttempts >= 2) {
    const peakBackoff = policy.backoffMs * Math.pow(multiplier, policy.maxAttempts - 2);
    if (peakBackoff > MAX_TIMER_MS) {
      throw new RangeError(
        `the backoff schedule overflows Node's setTimeout limit: attempt ` +
          `${policy.maxAttempts - 1} would sleep ${peakBackoff} ms, above ` +
          `${MAX_TIMER_MS}, which is silently clamped to 1 ms. Lower maxAttempts ` +
          `(${policy.maxAttempts}), backoffMs (${policy.backoffMs}) or ` +
          `backoffMultiplier (${multiplier}).`,
      );
    }
  }

  let lastError: unknown = undefined;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const classification = classify(err, attempt);
      if (classification === "hard") {
        policy.onAttempt?.({ err, attempt, classification, backoffMs: 0 });
        throw err;
      }
      const isLast = attempt === policy.maxAttempts;
      const backoff = isLast ? 0 : policy.backoffMs * Math.pow(multiplier, attempt - 1);
      policy.onAttempt?.({ err, attempt, classification, backoffMs: backoff });
      if (isLast) break;
      await sleep(backoff);
    }
  }
  throw new RetryBudgetExhaustedError(policy.maxAttempts, lastError);
}
