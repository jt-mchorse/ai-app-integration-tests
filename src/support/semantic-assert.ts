// Semantic similarity assertion for AI text outputs.
//
// LLM outputs vary across runs even with temperature=0 — token ties,
// model upgrades, prompt-cache reads vs writes. Exact-match assertions
// flake; relaxed assertions ("response contains 'refund'") false-negative
// on genuine drift. The middle path is **Jaccard similarity over
// normalized tokens**: cheap to compute, threshold-tunable, dep-free,
// and stable across minor wording changes.
//
// Not a replacement for an LLM-judge eval — that's `llm-eval-harness`'s
// job. This is the test-runtime smoke check: "the output is at least
// approximately the right thing", with a clear failure message when
// it isn't.

const DEFAULT_THRESHOLD = 0.6;

// A small, English-language stopword seed. Callers customize via
// `opts.stopwords` for non-English or domain-specific corpora.
const DEFAULT_STOPWORDS = new Set<string>([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "do",
  "for", "from", "had", "has", "have", "he", "her", "here", "his", "i",
  "if", "in", "into", "is", "it", "its", "of", "on", "or", "our", "she",
  "so", "than", "that", "the", "their", "them", "there", "they", "this",
  "to", "was", "we", "were", "what", "when", "where", "which", "who",
  "will", "with", "you", "your",
]);

export interface SemanticAssertOptions {
  // Minimum Jaccard similarity for the assertion to pass.
  // Default 0.6 — empirically the threshold where two paraphrases of the
  // same sentence agree and two semantically-different sentences don't.
  threshold?: number;
  stopwords?: ReadonlySet<string>;
  // Override for the failure-message label.
  label?: string;
}

// Pure tokenizer: lowercase, strip punctuation, split on whitespace,
// drop stopwords. Exposed so callers can apply the same normalization
// when computing their own diagnostics.
export function tokenize(text: string, stopwords?: ReadonlySet<string>): string[] {
  const stops = stopwords ?? DEFAULT_STOPWORDS;
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && !stops.has(tok));
}

// Jaccard similarity ∈ [0, 1] over token sets. Two empty token sets
// agree perfectly (1.0) — they're both "no informative content" — and
// the convention matches `set.equals` semantics; documented here
// because the implicit choice would otherwise confuse callers.
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  let intersection = 0;
  for (const tok of setA) if (setB.has(tok)) intersection++;
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0.0;
  return intersection / union;
}

export class SemanticMismatchError extends Error {
  similarity: number;
  threshold: number;
  actual: string;
  expected: string;
  constructor(
    actual: string,
    expected: string,
    similarity: number,
    threshold: number,
    label: string | undefined,
  ) {
    const labelPart = label ? `${label}: ` : "";
    super(
      `${labelPart}semantic similarity ${similarity.toFixed(3)} below threshold ${threshold.toFixed(2)}.\n` +
        `  actual:   ${actual}\n` +
        `  expected: ${expected}`,
    );
    this.name = "SemanticMismatchError";
    this.similarity = similarity;
    this.threshold = threshold;
    this.actual = actual;
    this.expected = expected;
  }
}

// Assert that `actual` is semantically similar to `expected`. Returns
// the computed similarity on success so callers can log it; throws
// `SemanticMismatchError` with both texts + the score on failure.
export function expectSemanticallySimilar(
  actual: string,
  expected: string,
  opts?: SemanticAssertOptions,
): number {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  // Finiteness guard. Pre-#24 the sign-range check `< 0 || > 1` was both
  // false for NaN — NaN comparisons are always false — so threshold = NaN
  // was accepted. Then `similarity < NaN` is also false, so the assertion
  // *always passed regardless of input* — silently vacuous, the worst kind
  // of degraded test guarantee.
  //
  // `threshold = 0` is the third route to that same vacuous pass, through the
  // operand the paragraph above already names (#109). It was inside the
  // accepted range, and `jaccardSimilarity` returns a value in [0, 1] **by
  // construction**, so `similarity < 0` can never be true. Measured, all
  // passing at `threshold: 0`:
  //
  //   "the sky is blue"               vs "refund window is 30 days"  -> 0.000  PASSES
  //   ""                              vs "refund window is 30 days"  -> 0.000  PASSES
  //   "ERROR: model returned nothing" vs "your refund was processed" -> 0.000  PASSES
  //
  // Not merely "the caller asked for it": `0` is what a *missing*
  // configuration coerces to, and the finiteness guard catches the noisy
  // sibling while admitting the silent one —
  //
  //   Number("")   === 0      parseFloat("") === NaN   -> rejected
  //   Number(" ")  === 0      Number("abc")  === NaN   -> rejected
  //   Number(null) === 0
  //
  // so `threshold: Number(process.env.SEMANTIC_THRESHOLD)` rejects a typo and
  // silently disables every semantic assertion in the suite when the variable
  // is simply unset.
  //
  // The upper end is NOT the mirror problem and must keep working: two
  // identical token sets score exactly 1.0, so `threshold: 1` is the strictest
  // real gate rather than an always-fail. Hence `(0, 1]`, the same half-open
  // shape `prompt-regression-suite`'s snapshot `tolerance` uses for the same
  // `>=`-style comparison.
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new RangeError(
      `threshold must be a finite number in (0, 1], got ${threshold}` +
        (threshold === 0
          ? ". Jaccard similarity is bounded below by 0, so a threshold of 0 makes " +
            "`similarity < threshold` unfalsifiable: the assertion would pass for " +
            "every actual, including an empty response. Note Number(\"\") and " +
            "Number(null) are both 0, so an unset config value lands here. If you " +
            "want no assertion, do not call one."
          : ""),
    );
  }
  const tokensA = tokenize(actual, opts?.stopwords);
  const tokensB = tokenize(expected, opts?.stopwords);
  // The threshold guard above covers ONE operand. The token sets are the other,
  // and they reach the same vacuous pass the comment there warns about (#99).
  //
  // `jaccardSimilarity` returns 1.0 for two empty sets — documented, and correct
  // as set semantics. But an `expected` with no informative tokens cannot
  // discriminate between ANY two inputs, so every comparison against it agrees.
  // Measured, all passing before this guard:
  //
  //   ""        vs "it is what it is"  -> [] vs []  -> 1.000  PASSES
  //   "..."     vs "the and of"        -> [] vs []  -> 1.000  PASSES
  //   "🎉🎉🎉"   vs "here we are"        -> [] vs []  -> 1.000  PASSES
  //   "  \n\t " vs "and so it was"     -> [] vs []  -> 1.000  PASSES
  //
  // An empty response from the model is exactly the failure a streaming-UI test
  // exists to catch, and it passed.
  //
  // The second route is sharper, because the `stopwords` option invites it —
  // "callers customize for non-English or domain-specific corpora". A caller
  // set that happens to cover both texts made "the sky is blue" and "refund
  // window is 30 days" compare equal. Two sentences with no words in common.
  //
  // Both routes run through an empty `tokensB`, so one rule closes both. This
  // is an authoring error like a NaN threshold, not a mismatch, so it throws a
  // distinct error rather than a `SemanticMismatchError` — there is no
  // meaningful similarity score to report.
  //
  // Deliberately NOT symmetric: an empty `tokensA` against a real `tokensB`
  // already yields 0.0 and fails with the score in the message, which is a
  // better diagnostic than this would be.
  if (tokensB.length === 0) {
    const cause =
      opts?.stopwords !== undefined
        ? "every token was dropped by the caller-supplied `stopwords` set"
        : "it contains only stopwords and/or non-letter characters";
    throw new RangeError(
      `expected text has no informative tokens (${cause}), so the assertion ` +
        `cannot discriminate between any two inputs and would pass for every ` +
        `actual — including an empty response. Give \`expected\` at least one ` +
        `content word, or narrow \`stopwords\`. expected: ${JSON.stringify(expected)}`,
    );
  }
  const similarity = jaccardSimilarity(tokensA, tokensB);
  if (similarity < threshold) {
    throw new SemanticMismatchError(actual, expected, similarity, threshold, opts?.label);
  }
  return similarity;
}
