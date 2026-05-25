// Unit tests for src/support/*. Synchronous-clock tests use injected
// `sleep` + `now` so the suite stays under a millisecond per case
// despite testing time-based behavior.

import { describe, expect, test } from "vitest";

import {
  defaultClassify,
  expectSemanticallySimilar,
  jaccardSimilarity,
  RetryBudgetExhaustedError,
  SemanticMismatchError,
  tokenize,
  waitFor,
  WaitTimeoutError,
  withRetryBudget,
} from "../src/support/index.js";

// ----- withRetryBudget --------------------------------------------------

describe("withRetryBudget", () => {
  const noSleep = async () => {};

  test("returns the function's value on first success", async () => {
    let calls = 0;
    const result = await withRetryBudget(
      async () => {
        calls++;
        return "ok";
      },
      { maxAttempts: 3, backoffMs: 0, sleep: noSleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries flaky errors up to the budget and succeeds before exhaustion", async () => {
    let calls = 0;
    const result = await withRetryBudget(
      async () => {
        calls++;
        if (calls < 3) {
          const err = new Error("ECONNRESET");
          throw err;
        }
        return "settled";
      },
      { maxAttempts: 5, backoffMs: 1, sleep: noSleep },
    );
    expect(result).toBe("settled");
    expect(calls).toBe(3);
  });

  test("hard errors short-circuit without consuming the budget", async () => {
    let calls = 0;
    const hardError = new TypeError("not a flake");
    await expect(
      withRetryBudget(
        async () => {
          calls++;
          throw hardError;
        },
        { maxAttempts: 5, backoffMs: 1, sleep: noSleep },
      ),
    ).rejects.toBe(hardError);
    expect(calls).toBe(1);
  });

  test("budget exhaustion rethrows a wrapper with the last error", async () => {
    let calls = 0;
    const err = new Error("ETIMEDOUT");
    await expect(
      withRetryBudget(
        async () => {
          calls++;
          throw err;
        },
        { maxAttempts: 3, backoffMs: 1, sleep: noSleep },
      ),
    ).rejects.toMatchObject({
      name: "RetryBudgetExhaustedError",
      attempts: 3,
      lastError: err,
    });
    expect(calls).toBe(3);
  });

  test("backoff multiplier grows the sleep value across attempts", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    await expect(
      withRetryBudget(
        async () => {
          throw new Error("ECONNREFUSED");
        },
        {
          maxAttempts: 4,
          backoffMs: 10,
          backoffMultiplier: 3,
          sleep,
        },
      ),
    ).rejects.toBeInstanceOf(RetryBudgetExhaustedError);
    // Three sleeps between four attempts: 10 × 3^0, 10 × 3^1, 10 × 3^2.
    expect(sleeps).toEqual([10, 30, 90]);
  });

  test("caller classifier overrides the default", async () => {
    let calls = 0;
    // Classify a TypeError as flake. Default would treat it as hard.
    const result = await withRetryBudget(
      async () => {
        calls++;
        if (calls < 2) throw new TypeError("first call");
        return "ok";
      },
      {
        maxAttempts: 3,
        backoffMs: 0,
        sleep: noSleep,
        classify: () => "flake",
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("onAttempt observer is called for every failure", async () => {
    const events: Array<{ attempt: number; backoffMs: number }> = [];
    await expect(
      withRetryBudget(
        async () => {
          throw new Error("ETIMEDOUT");
        },
        {
          maxAttempts: 3,
          backoffMs: 5,
          sleep: noSleep,
          onAttempt: ({ attempt, backoffMs }) => events.push({ attempt, backoffMs }),
        },
      ),
    ).rejects.toBeInstanceOf(RetryBudgetExhaustedError);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ attempt: 1, backoffMs: 5 });
    expect(events[1]).toEqual({ attempt: 2, backoffMs: 10 });
    // Last attempt's backoff is zero (we're about to throw).
    expect(events[2]).toEqual({ attempt: 3, backoffMs: 0 });
  });

  test("rejects invalid policy values", async () => {
    await expect(
      withRetryBudget(async () => "x", { maxAttempts: 0, backoffMs: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      withRetryBudget(async () => "x", { maxAttempts: 3, backoffMs: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  test("rejects non-positive backoffMultiplier (#22)", async () => {
    // Issue #22: only user-supplied values are validated — undefined still
    // resolves to the 2.0 default. Zero multiplier zeroes-out exponential
    // backoff; negative multiplier produces sign-alternating / NaN
    // backoffs via Math.pow that then poison sleep().
    await expect(
      withRetryBudget(async () => "x", {
        maxAttempts: 3,
        backoffMs: 1,
        backoffMultiplier: 0,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      withRetryBudget(async () => "x", {
        maxAttempts: 3,
        backoffMs: 1,
        backoffMultiplier: -1,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  test("accepts sub-1.0 backoffMultiplier (#22, regression-pin)", async () => {
    // 0.5 is a valid (decreasing) backoff multiplier — the guard is `> 0`
    // not `>= 1.0`, so a deliberately-decaying backoff is supported.
    const result = await withRetryBudget(async () => "ok", {
      maxAttempts: 2,
      backoffMs: 1,
      backoffMultiplier: 0.5,
      sleep: async () => {},
    });
    expect(result).toBe("ok");
  });

  test("defaultClassify treats network families as flake and other errors as hard", () => {
    expect(defaultClassify(new Error("ECONNRESET"))).toBe("flake");
    expect(defaultClassify(new Error("fetch failed"))).toBe("flake");
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(defaultClassify(aborted)).toBe("flake");
    const rate429 = Object.assign(new Error("rate limited"), { status: 429 });
    expect(defaultClassify(rate429)).toBe("flake");
    const server503 = Object.assign(new Error("upstream"), { status: 503 });
    expect(defaultClassify(server503)).toBe("flake");
    expect(defaultClassify(new TypeError("type"))).toBe("hard");
    const client404 = Object.assign(new Error("not found"), { status: 404 });
    expect(defaultClassify(client404)).toBe("hard");
  });
});

// ----- waitFor ----------------------------------------------------------

describe("waitFor", () => {
  test("resolves with the predicate's first truthy value", async () => {
    let calls = 0;
    const result = await waitFor(
      () => {
        calls++;
        return calls >= 3 ? "ready" : false;
      },
      { timeoutMs: 1000, intervalMs: 1, sleep: async () => {} },
    );
    expect(result).toBe("ready");
    expect(calls).toBe(3);
  });

  test("throws WaitTimeoutError with the last predicate value attached", async () => {
    let clock = 0;
    let lastSeen: number | undefined;
    await expect(
      waitFor(
        () => {
          lastSeen = clock;
          return false;
        },
        {
          timeoutMs: 50,
          intervalMs: 10,
          label: "ui-ready",
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
      ),
    ).rejects.toMatchObject({
      name: "WaitTimeoutError",
      label: "ui-ready",
      lastValue: false,
    });
    expect(lastSeen).toBeGreaterThanOrEqual(50);
  });

  test("polls await async predicates", async () => {
    let clock = 0;
    let attempts = 0;
    const result = await waitFor(
      async () => {
        attempts++;
        await Promise.resolve();
        return attempts >= 4 ? { ready: true } : null;
      },
      {
        timeoutMs: 1000,
        intervalMs: 5,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    );
    expect(result).toEqual({ ready: true });
    expect(attempts).toBe(4);
  });

  test("caps the final sleep so the deadline fires on time", async () => {
    const sleeps: number[] = [];
    let clock = 0;
    let calls = 0;
    await expect(
      waitFor(
        () => {
          calls++;
          return false;
        },
        {
          timeoutMs: 25,
          intervalMs: 10,
          sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
          },
          now: () => clock,
        },
      ),
    ).rejects.toBeInstanceOf(WaitTimeoutError);
    // After the first two full 10-ms sleeps elapsed=20; the next interval
    // would overshoot 25, so it should be capped to 5.
    expect(sleeps).toEqual([10, 10, 5]);
    // Predicate runs once per loop iteration (before each sleep) plus
    // once after the final sleep before timeout check.
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("rejects invalid timing options", async () => {
    await expect(
      waitFor(() => true, { timeoutMs: -1, intervalMs: 1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      waitFor(() => true, { timeoutMs: 1, intervalMs: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

// ----- expectSemanticallySimilar ---------------------------------------

describe("expectSemanticallySimilar", () => {
  test("passes on near-duplicate rewordings of the same answer", () => {
    // Jaccard is intentionally sensitive to token overlap; this test
    // demonstrates the floor where two phrasings share most content
    // words (modulo a few synonymic swaps). The threshold knob is
    // the operator's calibration surface; the helper math is what
    // it is.
    const sim = expectSemanticallySimilar(
      "Refunds available within 30 days of purchase, contact support.",
      "Refunds available within 30 days of purchase; contact support today.",
      { threshold: 0.6 },
    );
    expect(sim).toBeGreaterThan(0.6);
  });

  test("fails with a SemanticMismatchError on unrelated text", () => {
    expect(() =>
      expectSemanticallySimilar(
        "Refunds are available within 30 days of purchase.",
        "The sky was blue and the train was late.",
        { threshold: 0.5 },
      ),
    ).toThrowError(SemanticMismatchError);
  });

  test("error carries the similarity score, threshold, and both texts", () => {
    try {
      expectSemanticallySimilar("alpha", "omega", { threshold: 0.9, label: "demo" });
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SemanticMismatchError);
      const e = err as SemanticMismatchError;
      expect(e.threshold).toBe(0.9);
      expect(e.actual).toBe("alpha");
      expect(e.expected).toBe("omega");
      expect(e.message).toContain("demo");
    }
  });

  test("threshold knob raises or lowers the bar", () => {
    // Two phrasings that share *some* content words ({refund, days})
    // but not most. At a low threshold this should pass; at a high
    // threshold the same comparison fails. The knob is the whole point.
    const a = "refund window is 30 days";
    const b = "you can request a refund within 30 days";
    expect(() => expectSemanticallySimilar(a, b, { threshold: 0.3 })).not.toThrow();
    expect(() => expectSemanticallySimilar(a, b, { threshold: 0.9 })).toThrow();
  });

  test("rejects invalid thresholds", () => {
    expect(() => expectSemanticallySimilar("a", "b", { threshold: -0.1 })).toThrowError(
      RangeError,
    );
    expect(() => expectSemanticallySimilar("a", "b", { threshold: 1.5 })).toThrowError(
      RangeError,
    );
  });

  test("tokenize lowercases, strips punctuation, drops stopwords", () => {
    expect(tokenize("Hello, world!")).toEqual(["hello", "world"]);
    expect(tokenize("The quick BROWN fox.")).toEqual(["quick", "brown", "fox"]);
    expect(tokenize("the a an and")).toEqual([]);
  });

  test("custom stopwords replace the default set", () => {
    expect(tokenize("Hello world", new Set(["hello"]))).toEqual(["world"]);
    // With an empty stopword set, all tokens pass through.
    expect(tokenize("the quick fox", new Set())).toEqual(["the", "quick", "fox"]);
  });

  test("jaccardSimilarity returns 1 for two empty token bags", () => {
    expect(jaccardSimilarity([], [])).toBe(1.0);
  });

  test("jaccardSimilarity returns 1 for identical bags", () => {
    expect(jaccardSimilarity(["a", "b"], ["b", "a"])).toBe(1.0);
  });

  test("jaccardSimilarity is intersection/union", () => {
    // {a,b,c} ∩ {b,c,d} = 2; ∪ = 4; 2/4 = 0.5
    expect(jaccardSimilarity(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5, 6);
  });
});

// Issue #24: existing range validators in src/support/ were sign-only;
// NaN and +/-Infinity slipped past every guard and silently degraded test
// guarantees (vacuous semantic asserts, never-firing waits, abandoned
// retry backoffs). Finiteness guards added at each callsite.
describe("support — finiteness validation (issue #24)", () => {
  describe("waitFor", () => {
    test.each([
      { value: Number.NaN, label: "NaN" },
      { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
      { value: Number.NEGATIVE_INFINITY, label: "-Infinity" },
    ])("rejects timeoutMs = $label", async ({ value }) => {
      await expect(
        waitFor(() => true, { timeoutMs: value, intervalMs: 10 }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        waitFor(() => true, { timeoutMs: value, intervalMs: 10 }),
      ).rejects.toThrow(/timeoutMs must be a finite number/);
    });

    test.each([
      { value: Number.NaN, label: "NaN" },
      { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
      { value: Number.NEGATIVE_INFINITY, label: "-Infinity" },
    ])("rejects intervalMs = $label", async ({ value }) => {
      await expect(
        waitFor(() => true, { timeoutMs: 100, intervalMs: value }),
      ).rejects.toThrow(/intervalMs must be a finite number/);
    });

    test("accepts timeoutMs = 0 (regression — boundary stayed valid)", async () => {
      // First poll happens before any sleep, so a truthy predicate resolves
      // even with timeoutMs = 0.
      await expect(
        waitFor(() => true, { timeoutMs: 0, intervalMs: 1 }),
      ).resolves.toBe(true);
    });
  });

  describe("withRetryBudget", () => {
    const okFn = async () => "ok";

    test.each([
      { value: Number.NaN, label: "NaN" },
      { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
      { value: 2.5, label: "fractional" },
    ])("rejects maxAttempts = $label", async ({ value }) => {
      await expect(
        withRetryBudget(okFn, { maxAttempts: value, backoffMs: 0 }),
      ).rejects.toThrow(/maxAttempts must be an integer/);
    });

    test.each([
      { value: Number.NaN, label: "NaN" },
      { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
    ])("rejects backoffMs = $label", async ({ value }) => {
      await expect(
        withRetryBudget(okFn, { maxAttempts: 3, backoffMs: value }),
      ).rejects.toThrow(/backoffMs must be a finite number/);
    });

    test.each([
      { value: Number.NaN, label: "NaN" },
      { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
    ])("rejects backoffMultiplier = $label", async ({ value }) => {
      await expect(
        withRetryBudget(okFn, { maxAttempts: 3, backoffMs: 0, backoffMultiplier: value }),
      ).rejects.toThrow(/backoffMultiplier must be a finite number/);
    });

    test("regression — integer maxAttempts and finite backoffs still accepted", async () => {
      await expect(
        withRetryBudget(okFn, { maxAttempts: 1, backoffMs: 0, backoffMultiplier: 0.5 }),
      ).resolves.toBe("ok");
    });
  });

  describe("expectSemanticallySimilar threshold", () => {
    test.each([
      { value: Number.NaN, label: "NaN (would silently make assertion vacuous)" },
      { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
      { value: Number.NEGATIVE_INFINITY, label: "-Infinity" },
    ])("rejects threshold = $label", ({ value }) => {
      expect(() =>
        expectSemanticallySimilar("a b c", "a b c", { threshold: value }),
      ).toThrow(/threshold must be a finite number/);
    });

    test("regression — finite threshold in [0, 1] still accepted", () => {
      expect(() => expectSemanticallySimilar("a b c", "a b c", { threshold: 0.5 })).not.toThrow();
      expect(() => expectSemanticallySimilar("a b c", "a b c", { threshold: 0 })).not.toThrow();
      expect(() => expectSemanticallySimilar("a b c", "a b c", { threshold: 1 })).not.toThrow();
    });
  });
});
