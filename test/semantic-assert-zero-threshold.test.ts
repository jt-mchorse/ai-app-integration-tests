/**
 * `threshold: 0` is the third route to a vacuous semantic assertion (#109).
 *
 * `expectSemanticallySimilar` gates on `similarity < threshold`, and both of
 * its existing guards exist to stop that comparison becoming unfalsifiable:
 *
 *   #24 — a NaN threshold made every comparison false, so "the assertion
 *         always passed regardless of input — silently vacuous, the worst kind
 *         of degraded test guarantee."
 *   #99 — "The threshold guard above covers ONE operand. The token sets are the
 *         other, and they reach the same vacuous pass."
 *
 * `0` reaches it through the operand #24 already names. It was inside the
 * accepted `[0, 1]` range, and `jaccardSimilarity` returns a value in `[0, 1]`
 * **by construction**, so `similarity < 0` can never be true. Measured before
 * the fix, every row passing:
 *
 *     "the sky is blue"               vs "refund window is 30 days"  -> 0.000
 *     ""                              vs "refund window is 30 days"  -> 0.000
 *     "ERROR: model returned nothing" vs "your refund was processed" -> 0.000
 *
 * The reachability is what makes it worth a guard rather than a doc note:
 * `Number("")`, `Number(" ")` and `Number(null)` are all **0**, while
 * `Number("abc")` and `parseFloat("")` are NaN. The pre-existing guard rejects
 * a *typo'd* config value and admits a *missing* one — so
 * `threshold: Number(process.env.SEMANTIC_THRESHOLD)` disables every semantic
 * assertion in a suite when the variable is simply unset.
 *
 * The upper end is deliberately NOT symmetric, and there is a test for that
 * below: two identical token sets score exactly 1.0, so `threshold: 1` is the
 * strictest real gate, not an always-fail. Without that arm, the next person
 * tightening this range closes it to `(0, 1)` and breaks a legitimate config.
 */
import { describe, expect, it } from "vitest";

import { expectSemanticallySimilar, jaccardSimilarity, tokenize } from "../src/index.js";

// The measured table from the issue: pairs that a semantic assertion exists to
// separate. Every one of them passed at `threshold: 0`.
const UNRELATED_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ["no words in common", "the sky is blue", "refund window is 30 days"],
  ["empty actual", "", "refund window is 30 days"],
  [
    "the failure the test exists to catch",
    "ERROR: model returned nothing",
    "your refund was processed",
  ],
  ["actual is only stopwords", "it is what it is", "your refund was processed"],
];

// Values that coerce to 0 the way a *missing* configuration does, alongside the
// NaN siblings the pre-existing guard already caught. Both columns must be
// rejected; the point is that only one of them used to be.
const ZERO_COERCIONS: ReadonlyArray<readonly [string, unknown]> = [
  ["literal 0", 0],
  ['Number("")', Number("")],
  ['Number(" ")', Number(" ")],
  ["Number(null)", Number(null)],
  ["-0", -0],
];

const NAN_COERCIONS: ReadonlyArray<readonly [string, unknown]> = [
  ['Number("abc")', Number("abc")],
  ['parseFloat("")', parseFloat("")],
  ["Number(undefined)", Number(undefined)],
];

describe("a zero threshold cannot fire, so it is refused", () => {
  it.each(ZERO_COERCIONS)("%s is rejected", (label, value) => {
    expect(() =>
      expectSemanticallySimilar("the sky is blue", "refund window is 30 days", {
        threshold: value as number,
      }),
    ).toThrow(RangeError);
  });

  it.each(ZERO_COERCIONS)("%s says why, not just the range", (label, value) => {
    // A message that only restates "must be in (0, 1]" leaves the reader to
    // rediscover that 0 is unfalsifiable rather than merely out of range.
    try {
      expectSemanticallySimilar("a", "refund window", { threshold: value as number });
      expect.unreachable("expected a RangeError");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("(0, 1]");
      expect(message).toContain("unfalsifiable");
      expect(message).toContain("empty response");
    }
  });

  it.each(UNRELATED_PAIRS)(
    "%s: rejected at threshold 0 instead of passing at 0.000",
    (label, actual, expected) => {
      expect(() =>
        expectSemanticallySimilar(actual, expected, { threshold: 0 }),
      ).toThrow(RangeError);
      // And the pair really is unrelated — the score it *would* have reported.
      // Without this the rows above could be passing for the wrong reason.
      expect(jaccardSimilarity(tokenize(actual), tokenize(expected))).toBe(0);
    },
  );

  it.each(UNRELATED_PAIRS)(
    "%s: still fails as a mismatch at the default threshold",
    (label, actual, expected) => {
      // The other direction. If the fix had somehow turned these into
      // `RangeError`s at every threshold, the rows above would pass while the
      // helper had stopped working.
      expect(() => expectSemanticallySimilar(actual, expected)).toThrow(
        /semantic similarity/,
      );
    },
  );

  it.each(NAN_COERCIONS)("%s is still rejected, as before (#24)", (label, value) => {
    expect(() =>
      expectSemanticallySimilar("a b c", "a b c", { threshold: value as number }),
    ).toThrow(RangeError);
  });

  it("the two coercion columns really are different values", () => {
    // Anti-vacuous: this whole file rests on `Number("")` being 0 while
    // `Number("abc")` is NaN. If that stopped being true the tables above would
    // be testing one case twice.
    // `===` rather than `toBe`, which is `Object.is` and separates -0 from 0.
    // -0 is in the table on purpose: it is a real coercion result and
    // `-0 <= 0` is true, so the guard catches it.
    for (const [, value] of ZERO_COERCIONS) expect(value === 0).toBe(true);
    for (const [, value] of NAN_COERCIONS) expect(Number.isNaN(value as number)).toBe(true);
  });
});

describe("the upper end is a real threshold, not the mirror defect", () => {
  it("threshold 1 passes for identical token sets", () => {
    // Two identical token sets score exactly 1.0, and the gate is
    // `similarity < threshold`, so 1 is satisfiable — it is the strictest
    // possible gate rather than an always-fail. Narrowing the range to
    // `(0, 1)` would break this.
    expect(expectSemanticallySimilar("refund window is 30 days", "refund window is 30 days", {
      threshold: 1,
    })).toBe(1);
  });

  it("threshold 1 still fails on a near-miss", () => {
    // Anti-vacuous partner: 1 must be strict, not merely accepted.
    expect(() =>
      expectSemanticallySimilar("refund window is 30 days", "refund window is 14 days", {
        threshold: 1,
      }),
    ).toThrow(/semantic similarity/);
  });

  it("threshold just above 1 is still rejected", () => {
    expect(() =>
      expectSemanticallySimilar("a b", "a b", { threshold: 1.000001 }),
    ).toThrow(RangeError);
  });

  it("an ordinary threshold in between is unaffected", () => {
    // The control: the change is at the endpoints, and the documented working
    // range must behave exactly as before.
    expect(
      expectSemanticallySimilar(
        "the refund window is thirty days",
        "refund window is 30 days",
        { threshold: 0.3 },
      ),
    ).toBeGreaterThan(0.3);
  });
});
