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
