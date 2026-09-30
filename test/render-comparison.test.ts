// A stated ordering stays readable when its two numbers are rendered (#125).
//
// `expectSemanticallySimilar` decides at full precision — `similarity <
// threshold` — and explained the decision at two *different* fixed widths,
// `toFixed(3)` against `toFixed(2)`. At `similarity = 0.7449` against a
// `threshold` of `0.745` that rendered `semantic similarity 0.745 below
// threshold 0.74`: the message names the larger number as the smaller one.
//
// No test in this suite could have caught it. The gate is correct in every
// colliding case, so nothing asserting on pass/fail can fire. The only thing
// wrong was that the sentence disagreed with itself, and nothing asserted that a
// sentence is self-consistent.
//
// The central arms are margin *searches*, in **both orientations**. A
// one-orientation sweep passes the widen-one-side neighbour — measured in
// `prompt-regression-suite#175`, where that neighbour passed all 42 arms until a
// reversed-orientation sweep was added.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderComparison } from "../src/support/render-comparison.js";
import {
  SemanticMismatchError,
  expectSemanticallySimilar,
} from "../src/support/semantic-assert.js";

// Margins spanning both sides of the old boundary, so the sweeps cover the
// region `toFixed(3)`/`toFixed(2)` handled and the region they did not.
const MARGINS = [
  5e-1, 1e-1, 1e-2, 1e-3, 5e-4, 1e-4, 1e-5, 1e-6, 1e-8, 1e-10, 1e-12, 1e-14,
];

// Decimal places in a fixed-point rendering; null for the exponential fallback.
function placesOf(rendered: string): number | null {
  if (rendered.includes("e") || rendered.includes("E")) return null;
  const dot = rendered.indexOf(".");
  return dot === -1 ? 0 : rendered.length - dot - 1;
}

describe("renderComparison", () => {
  it.each(MARGINS)(
    "keeps the ordering visible when the VALUE carries the extra digits (margin %s)",
    (margin) => {
      const threshold = 0.75;
      const value = threshold - margin;
      const [renderedValue, renderedThreshold] = renderComparison(value, threshold, 3);
      expect(renderedValue).not.toBe(renderedThreshold);
      expect(parseFloat(renderedValue)).toBeLessThan(parseFloat(renderedThreshold));
    },
  );

  it.each(MARGINS)(
    "keeps the ordering visible when the THRESHOLD carries the extra digits (margin %s)",
    (margin) => {
      // This is the orientation the shipped code got backwards: the threshold's
      // `toFixed(2)` truncated `0.745` to `0.74`, below the similarity as
      // rendered. A sweep that only ever puts the long expansion on the value
      // side cannot see it.
      const value = 0.3;
      const threshold = value + margin;
      const [renderedValue, renderedThreshold] = renderComparison(value, threshold, 3);
      expect(renderedValue).not.toBe(renderedThreshold);
      expect(parseFloat(renderedValue)).toBeLessThan(parseFloat(renderedThreshold));
    },
  );

  it.each([
    [0.75 - 1e-8, 0.75],
    [0.3, 0.3 + 1e-8],
    [0.7449, 0.745],
    [0.74999, 0.75],
    [0.3, 0.75],
  ])("renders both sides at the same width (%s vs %s)", (value, other) => {
    // The structural property. An outcome assertion only catches mismatched
    // precision in the orientation where the outcome comes out visibly wrong;
    // this catches it in both, and it is the property the shipped code violated
    // by construction.
    const [a, b] = renderComparison(value, other, 3);
    expect(placesOf(a)).toBe(placesOf(b));
  });

  it("never narrows below the caller's width", () => {
    // `llm-eval-harness#252` shipped a narrowing regression this same week — a
    // helper that hardcoded a width silently republished a four-place column at
    // three — and only that repo's published-values lock caught it. There is no
    // equivalent lock here, so this arm stands in for one. Matching the widths
    // must not be done by dropping the similarity to the threshold's two places.
    expect(renderComparison(0.3, 0.75, 3)).toStrictEqual(["0.300", "0.750"]);
    expect(placesOf(renderComparison(0.3, 0.75, 3)[0])).toBe(3);
    // ...and it still widens past the caller's width when three is not enough.
    const [wide, wideOther] = renderComparison(0.75 - 1e-8, 0.75, 3);
    expect(wide).not.toBe(wideOther);
    expect(placesOf(wide)!).toBeGreaterThan(3);
  });

  it("does not widen equal inputs", () => {
    // Nothing to distinguish, so nothing is implied. Unreachable from the
    // caller's message (a strict `<`), but the function is total.
    expect(renderComparison(0.75, 0.75, 3)).toStrictEqual(["0.750", "0.750"]);
  });

  it("falls back to exponential form when no fixed width can separate the two", () => {
    // The 17-place ceiling is a ceiling, not a guarantee. Asserted in that order
    // on purpose: the collision first, then that the fallback resolves it.
    expect((1e-300).toFixed(17)).toBe((2e-300).toFixed(17));
    expect(renderComparison(1e-300, 2e-300, 3)).toStrictEqual(["1e-300", "2e-300"]);
  });
});

describe("SemanticMismatchError's message", () => {
  // Drives the real assertion rather than constructing the error, so these arms
  // also pin that the call site is wired up. A helper-level check stays green
  // against a call-site revert.
  function failWith(threshold: number): SemanticMismatchError {
    // `tokenize`/`jaccardSimilarity` are deterministic, so a fixed pair of
    // strings gives a fixed similarity. Two of three content tokens shared:
    // 2/4 = 0.5 by Jaccard over the normalized token sets.
    try {
      expectSemanticallySimilar("alpha beta gamma", "alpha beta delta", { threshold });
    } catch (error) {
      if (error instanceof SemanticMismatchError) return error;
      throw error;
    }
    throw new Error(`expected a SemanticMismatchError at threshold ${threshold}`);
  }

  it("states the similarity it measured, so the arms below are not testing a guess", () => {
    const error = failWith(0.9);
    expect(error.similarity).toBeCloseTo(0.5, 10);
  });

  it.each([1e-3, 1e-4, 1e-6, 1e-8, 1e-10])(
    "never reads as equal or backwards at a margin of %s",
    (margin) => {
      const error = failWith(0.5 + margin);
      // Anchored on the sentence-ending `.\n`, not on `(\S+?)\.`: the
      // non-greedy form captures `0` out of `0.501.` and quietly compares
      // against zero, which passed the "not equal" arm and failed the ordering
      // one for the wrong reason.
      const match = /similarity (\S+) below threshold (.+?)\.\n/.exec(error.message);
      expect(match).not.toBeNull();
      const [, renderedSimilarity, renderedThreshold] = match!;
      expect(renderedSimilarity).not.toBe(renderedThreshold);
      expect(parseFloat(renderedSimilarity)).toBeLessThan(
        parseFloat(renderedThreshold),
      );
      expect(placesOf(renderedSimilarity)).toBe(placesOf(renderedThreshold));
    },
  );

  it("leaves an ordinary mismatch message unchanged", () => {
    // The control. A wide margin still renders at three places on both sides,
    // which is what separates this fix from simply widening the width.
    const error = failWith(0.9);
    expect(error.message).toContain("semantic similarity 0.500 below threshold 0.900");
  });

  it("keeps the structured fields at full precision", () => {
    // The data was never wrong — only the prose. If a future change "fixes" the
    // message by rounding the fields, a consumer loses the real numbers.
    const error = failWith(0.5 + 1e-9);
    expect(error.threshold).toBe(0.5 + 1e-9);
    expect(error.similarity).toBeCloseTo(0.5, 12);
  });
});

// ---------------------------------------------------------------------------
// A configured operand reads back as itself (#127, D-014)
// ---------------------------------------------------------------------------

// Thresholds finer than the published width. Each is a legal `opts.threshold`:
// the guard requires finite and in `(0, 1]`, never a width.
const FINE_THRESHOLDS = [0.85004, 0.7512345, 0.750001, 0.9000001, 0.123456789];

describe("renderComparison marks a configured operand", () => {
  it.each(FINE_THRESHOLDS)(
    "the marked operand reads back as itself (threshold %s)",
    (threshold) => {
      const [, renderedThreshold] = renderComparison(0.5, threshold, 3, {
        exactOther: true,
      });
      expect(Number(renderedThreshold)).toBe(threshold);
    },
  );

  it.each(FINE_THRESHOLDS)(
    "marking keeps both sides at one width (threshold %s)",
    (threshold) => {
      // D-013's invariant survives D-014. Widening only the marked side is the
      // pre-#125 shape: two different widths, which named the larger number as
      // the smaller.
      const [value, other] = renderComparison(0.5, threshold, 3, { exactOther: true });
      expect(placesOf(value)).toBe(placesOf(other));
    },
  );

  it("is off by default, so every pre-#127 caller renders exactly as it did", () => {
    expect(renderComparison(0.92, 0.85004, 3)).toEqual(["0.920", "0.850"]);
    expect(renderComparison(0.92, 0.85004, 3, { exactOther: true })).toEqual([
      "0.92000",
      "0.85004",
    ]);
  });

  it("marks either side, because the one-flag claim was falsified elsewhere", () => {
    // `llm-eval-harness` D-029 shipped `exact_other` alone on the grounds that
    // the value is always the measured side; `prompt-regression-suite`#181
    // falsified that the same day with a site comparing two configured numbers.
    // Only `other` is configured here today — this arm exists so the symmetric
    // signature is a decision rather than dead weight nobody can justify.
    expect(renderComparison(0.123456789, 0.5, 3, { exactValue: true })[0]).toBe(
      "0.123456789",
    );
    const [v, o] = renderComparison(0.123456789, 0.9000001, 3, {
      exactValue: true,
      exactOther: true,
    });
    expect(Number(v)).toBe(0.123456789);
    expect(Number(o)).toBe(0.9000001);
    expect(placesOf(v)).toBe(placesOf(o));
  });

  it("widens an equal pair when an operand is marked", () => {
    // The one documented D-013 behaviour marking overrides: misreporting the
    // configuration is a false claim whether or not the measurement equals it.
    expect(renderComparison(0.85004, 0.85004, 3)).toEqual(["0.850", "0.850"]);
    expect(renderComparison(0.85004, 0.85004, 3, { exactOther: true })).toEqual([
      "0.85004",
      "0.85004",
    ]);
  });

  it("a round threshold is unchanged, which is why this was invisible", () => {
    // `DEFAULT_THRESHOLD` and every threshold in this suite round-trip at three
    // places already. The defect needs a test author who configured something
    // finer, and no test in this repo did.
    for (const threshold of [0.7, 0.75, 0.8, 0.9]) {
      expect(renderComparison(0.5, threshold, 3, { exactOther: true })).toEqual(
        renderComparison(0.5, threshold, 3),
      );
    }
  });
});

describe("the mismatch message names the threshold in force", () => {
  function failWithFine(threshold: number): SemanticMismatchError {
    try {
      expectSemanticallySimilar("alpha beta gamma", "alpha beta delta", { threshold });
    } catch (error) {
      if (error instanceof SemanticMismatchError) return error;
      throw error;
    }
    throw new Error(`expected a SemanticMismatchError at threshold ${threshold}`);
  }

  it.each(FINE_THRESHOLDS.filter((t) => t > 0.5))(
    "through the real assertion, not the helper (threshold %s)",
    (threshold) => {
      // Driven through `expectSemanticallySimilar` so a call-site revert is red
      // here. An arm on `renderComparison` alone stays green against it.
      const message = failWithFine(threshold).message;
      // Anchored on the end of the line, not on the first `.`: a lazy
      // `\S+?` before `\.` captures "0" out of "0.85004." and every arm
      // then compares against +0, which is a passing-looking failure.
      const match = /below threshold (.+?)\.\n/.exec(message);
      expect(match, message).not.toBeNull();
      expect(Number(match![1])).toBe(threshold);
    },
  );

  it("still renders both sides of the message at one width", () => {
    const message = failWithFine(0.85004).message;
    const match = /similarity (\S+) below threshold (.+?)\.\n/.exec(message);
    expect(match, message).not.toBeNull();
    expect(placesOf(match![1])).toBe(placesOf(match![2]));
  });

  it("leaves the ordinary message byte-identical", () => {
    // The shipped shape: a round threshold, three places, unchanged by #127.
    expect(failWithFine(0.9).message).toContain(
      "semantic similarity 0.500 below threshold 0.900.",
    );
  });

  it("keeps the structured fields at full precision, as D-013 requires", () => {
    // The fields were never wrong; only the prose was. Pinned so a future change
    // cannot fix a message by rounding the fields and taking the real numbers
    // away from a consumer.
    const error = failWithFine(0.85004);
    expect(error.threshold).toBe(0.85004);
    expect(error.similarity).toBeCloseTo(0.5, 10);
  });
});

describe("the population", () => {
  it("every renderComparison call against a configured value marks it", () => {
    // Derived from the source rather than listing today's one call site, so a
    // second surface inherits the rule. Keyed on the argument being a
    // configured name, which in this package means a threshold.
    const source = readFileSync(
      new URL("../src/support/semantic-assert.ts", import.meta.url),
      "utf8",
    );
    const calls = [...source.matchAll(/renderComparison\(([\s\S]*?)\n\s*\);/g)];
    expect(calls.length, "no renderComparison call found in semantic-assert.ts").toBe(1);
    for (const [call] of calls) {
      if (!/\bthreshold\b/.test(call)) continue;
      expect(call, "a call against a configured threshold must mark it").toMatch(
        /exactOther:\s*true/,
      );
    }
  });

  it("the threshold really is caller-supplied, which is the whole premise", () => {
    // If `threshold` were a module constant this would be a guard with no harm
    // to name. It is an option a test author passes.
    const source = readFileSync(
      new URL("../src/support/semantic-assert.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/const threshold = opts\?\.threshold \?\? DEFAULT_THRESHOLD;/);
  });
});
