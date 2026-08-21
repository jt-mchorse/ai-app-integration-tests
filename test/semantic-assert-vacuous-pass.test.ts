/**
 * An assertion that cannot discriminate must fail loudly (#99).
 *
 * `expectSemanticallySimilar` already guards its `threshold` against NaN, and
 * its comment says exactly why: `similarity < NaN` is false, so "the assertion
 * always passed regardless of input — silently vacuous, the worst kind of
 * degraded test guarantee."
 *
 * That reasoning covers one operand. The token sets are the other, and they
 * reached the same vacuous pass by two unguarded routes:
 *
 *  1. `tokenize` strips everything that isn't a letter, digit or whitespace and
 *     then drops stopwords, so `""`, `"..."`, `"🎉🎉🎉"` and whitespace all
 *     produce `[]`. Against an all-stopword `expected` — `"it is what it is"` —
 *     both sets are empty, `jaccardSimilarity` returns 1.0, and it PASSED. An
 *     empty model response is precisely what a streaming-UI test exists to
 *     catch.
 *
 *  2. The `stopwords` option invites callers to customize "for non-English or
 *     domain-specific corpora". A set that happens to cover both texts made two
 *     sentences with NO words in common compare equal.
 *
 * Both run through an empty `tokensB`, so one rule closes both.
 *
 * The tests are anchored to the measured pre-fix verdicts, because the pre-fix
 * code threw nothing — it reported agreement.
 */

import { describe, expect, it } from "vitest";
import {
  SemanticMismatchError,
  expectSemanticallySimilar,
  jaccardSimilarity,
  tokenize,
} from "../src/support/semantic-assert.js";

/** An `expected` that survives tokenization to nothing. */
const ALL_STOPWORD_EXPECTED = "it is what it is";

/** Actuals that tokenize to nothing. All PASSED pre-fix. */
const EMPTY_TOKENIZING_ACTUALS: Array<[string, string]> = [
  ["empty string", ""],
  ["punctuation only", "..."],
  ["emoji only", "🎉🎉🎉"],
  ["whitespace only", "   \n\t "],
];

describe("the premise (#99)", () => {
  it("these actuals really do tokenize to nothing", () => {
    for (const [label, actual] of EMPTY_TOKENIZING_ACTUALS) {
      expect(tokenize(actual), label).toEqual([]);
    }
  });

  it("an all-stopword expected really does tokenize to nothing", () => {
    expect(tokenize(ALL_STOPWORD_EXPECTED)).toEqual([]);
  });

  it("jaccardSimilarity keeps its documented both-empty convention", () => {
    // NOT the bug, and deliberately unchanged: it is a pure exported helper
    // whose set semantics are correct. The defect was at the assertion
    // boundary, which is where the test guarantee lives.
    expect(jaccardSimilarity([], [])).toBe(1.0);
  });
});

describe("route 1: an uninformative expected (#99)", () => {
  for (const [label, actual] of EMPTY_TOKENIZING_ACTUALS) {
    it(`rejects ${label} actual against an all-stopword expected`, () => {
      // Pre-fix: similarity 1.000, PASSES.
      expect(() => expectSemanticallySimilar(actual, ALL_STOPWORD_EXPECTED)).toThrow(
        /no informative tokens/,
      );
    });
  }

  it("rejects empty against empty", () => {
    expect(() => expectSemanticallySimilar("", "")).toThrow(/no informative tokens/);
  });

  it("names stopwords-and-punctuation as the cause when no stopword set was passed", () => {
    expect(() => expectSemanticallySimilar("", ALL_STOPWORD_EXPECTED)).toThrow(
      /only stopwords and\/or non-letter characters/,
    );
  });

  it("rejects even when the actual is perfectly good", () => {
    // The assertion is unusable regardless of what it is handed — that is the
    // point. Pre-fix this one already failed, but with a *mismatch* error that
    // blamed the actual rather than the unusable expected.
    expect(() =>
      expectSemanticallySimilar("refund window is 30 days", ALL_STOPWORD_EXPECTED),
    ).toThrow(/no informative tokens/);
  });
});

describe("route 2: caller stopwords swallow the expected (#99)", () => {
  const swallowAll = new Set(["refund", "window", "30", "days", "sky", "blue", "is", "the"]);

  it("two unrelated sentences no longer pass", () => {
    // Pre-fix: PASSES. No words in common.
    expect(() =>
      expectSemanticallySimilar("the sky is blue", "refund window is 30 days", {
        stopwords: swallowAll,
      }),
    ).toThrow(/no informative tokens/);
  });

  it("names the caller's stopword set as the cause", () => {
    expect(() =>
      expectSemanticallySimilar("the sky is blue", "refund window is 30 days", {
        stopwords: swallowAll,
      }),
    ).toThrow(/caller-supplied `stopwords` set/);
  });

  it("a caller stopword set that leaves content words alone still works", () => {
    const narrow = new Set(["the", "is"]);
    const sim = expectSemanticallySimilar(
      "refund window is 30 days",
      "the refund window is 30 days",
      { stopwords: narrow },
    );
    expect(sim).toBeGreaterThan(0.6);
  });
});

describe("what must NOT change (#99)", () => {
  it("an empty actual against a real expected still reports a mismatch with its score", () => {
    // Deliberately not symmetric. This path already failed usefully — the
    // failure message carries similarity 0.000 — and turning it into the new
    // error would lose that diagnostic.
    let err: unknown;
    try {
      expectSemanticallySimilar("", "refund window is 30 days");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SemanticMismatchError);
    expect((err as SemanticMismatchError).similarity).toBe(0);
  });

  it("a real mismatch still reports a mismatch", () => {
    expect(() => expectSemanticallySimilar("the sky is blue", "refund window is 30 days")).toThrow(
      SemanticMismatchError,
    );
  });

  it("a real match still passes and returns the similarity", () => {
    const sim = expectSemanticallySimilar(
      "refund window is 30 days",
      "the refund window is 30 days",
    );
    expect(sim).toBe(1);
  });

  it("the NaN-threshold guard the token guard is modelled on still fires", () => {
    expect(() =>
      expectSemanticallySimilar("a b c", "a b c", { threshold: Number.NaN }),
    ).toThrow(RangeError);
  });

  it("the threshold guard runs before the token guard", () => {
    // Both are authoring errors; the threshold one is checked first, so a call
    // with both problems reports the threshold. Pinned so the ordering is a
    // decision rather than an accident.
    expect(() => expectSemanticallySimilar("", "", { threshold: 5 })).toThrow(
      /threshold must be a finite number/,
    );
  });
});
