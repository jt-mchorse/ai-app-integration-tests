// Flake-reduction helpers (#3).
//
// Three patterns that compose:
//   - `withRetryBudget` for bounded retries on classified flake errors
//   - `waitFor` for time-bounded predicate polling
//   - `expectSemanticallySimilar` for assertion over AI text outputs
//
// See `docs/patterns.md` for the per-helper writeups + composition rule.

export {
  RetryBudgetExhaustedError,
  defaultClassify,
  withRetryBudget,
  type FlakeClassification,
  type RetryPolicy,
} from "./retry-budget.js";

export {
  WaitTimeoutError,
  waitFor,
  type WaitForOptions,
} from "./wait-for.js";

export {
  SemanticMismatchError,
  expectSemanticallySimilar,
  jaccardSimilarity,
  tokenize,
  type SemanticAssertOptions,
} from "./semantic-assert.js";
