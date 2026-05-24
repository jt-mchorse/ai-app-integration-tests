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
  if (policy.maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be >= 1, got ${policy.maxAttempts}`);
  }
  if (policy.backoffMs < 0) {
    throw new RangeError(`backoffMs must be >= 0, got ${policy.backoffMs}`);
  }
  // Only validate user-supplied values — undefined still resolves to the
  // 2.0 default below. A non-positive multiplier produces 0 or alternating-
  // sign / NaN backoffs (Math.pow with a non-positive base on a fractional
  // exponent is NaN), which then poison the sleep() call. Catching it here
  // surfaces the bug at the boundary instead of mid-loop.
  if (policy.backoffMultiplier !== undefined && policy.backoffMultiplier <= 0) {
    throw new RangeError(
      `backoffMultiplier must be > 0, got ${policy.backoffMultiplier}`,
    );
  }
  const classify = policy.classify ?? defaultClassify;
  const sleep = policy.sleep ?? defaultSleep;
  const multiplier = policy.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;

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
