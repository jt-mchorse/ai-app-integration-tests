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
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError(`threshold must be a finite number in [0, 1], got ${threshold}`);
  }
  const tokensA = tokenize(actual, opts?.stopwords);
  const tokensB = tokenize(expected, opts?.stopwords);
  const similarity = jaccardSimilarity(tokensA, tokensB);
  if (similarity < threshold) {
    throw new SemanticMismatchError(actual, expected, similarity, threshold, opts?.label);
  }
  return similarity;
}
