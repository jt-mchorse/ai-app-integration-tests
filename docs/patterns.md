# Flake-reduction patterns

Three small helpers, all under `src/support/`, that compose into the
test-runtime layer for AI features. Each one is dep-free TypeScript;
together they handle the three failure modes that make AI-feature
tests flake.

The patterns are deliberately **runtime helpers**, not test-framework
plugins. They work inside any vitest/jest/playwright suite, and they
don't take over the runner — the test file decides when to wrap, when
to wait, when to assert.

---

## 1. Retry budgets — `withRetryBudget`

**Failure mode.** Tests that touch a flaky surface (the LLM API, a
remote tool, a streaming connection that occasionally drops) need to
retry to be reliable — but unbounded retries hide real bugs. The
common mistake is `while (true) try {...} catch (_) { /* keep going */ }`
which silently loops on a 100% reproducible failure.

**API.**

```typescript
import { withRetryBudget } from "ai-app-integration-tests";

const response = await withRetryBudget(
  () => callTheModel(),
  {
    maxAttempts: 3,
    backoffMs: 100,
    backoffMultiplier: 2.0, // optional; default 2.0 (100ms, 200ms, 400ms)
    // optional; default classifier treats network families + 429 + 5xx as flake
    classify: (err) => (isMyTransientError(err) ? "flake" : "hard"),
  },
);
```

**Behavior.**
- The classifier decides per-error whether to retry. Hard errors
  short-circuit immediately; flake errors consume the budget.
- The default classifier treats `AbortError`, `TimeoutError`,
  `ECONNRESET` / `ECONNREFUSED` / `ETIMEDOUT` / `fetch failed`, and HTTP
  429 + 5xx as flake. Everything else is hard.
- Budget exhaustion throws `RetryBudgetExhaustedError` with the
  attempt count and the last underlying error.
- Backoff is `backoffMs × backoffMultiplier^(attempt-1)`.
- `onAttempt` observer is called on every failed attempt for
  diagnostics; `sleep` is pluggable so unit tests can drive it
  synchronously.

**When *not* to use.** If the surface you're testing has an SLA you
care about, a passing test that took five retries to settle is
hiding the SLA breach. Retry budgets are for genuinely transient
issues, not for masking latency regressions.

---

## 2. Time-bounded waits — `waitFor`

**Failure mode.** "Wait until the UI shows the streamed response" is
where naïve tests reach for `await sleep(2000)`. Sleep too long and
the suite drags; sleep too short and the suite flakes. `waitFor` is
the polled, time-bounded version.

**API.**

```typescript
import { waitFor } from "ai-app-integration-tests";

const finalText = await waitFor(
  () => page.locator(".response").textContent(),
  {
    timeoutMs: 5000,
    intervalMs: 100,
    label: "streamed-response", // shown in the timeout error message
  },
);
```

**Behavior.**
- Polls `predicate()` (sync or async) every `intervalMs` until it
  returns a *truthy* value; resolves with that value.
- On timeout throws `WaitTimeoutError` with the elapsed time, the
  label, and the last predicate value attached — so debugging starts
  with a real signal instead of "test timed out somewhere."
- The final poll interval is capped to `timeoutMs - elapsed` so the
  deadline fires at the documented moment, not `intervalMs` past it.
- `sleep` and `now` are injectable for hermetic unit tests.

**Composes with retry budgets.** A `waitFor` timeout is a *hard* error
under the default classifier — don't retry across a missed deadline.
If your scenario legitimately involves a retry over the whole
wait-for-then-assert flow, classify the timeout as flake in the
caller's `classify` callback.

---

## 3. Semantic assertions — `expectSemanticallySimilar`

**Failure mode.** LLM outputs vary across runs even at
`temperature=0` (token ties, model upgrades, prompt-cache reads vs
writes). Exact-match assertions flake; relaxed assertions ("response
contains 'refund'") false-negative on real drift. The middle path is
**Jaccard similarity over normalized tokens**.

**API.**

```typescript
import { expectSemanticallySimilar } from "ai-app-integration-tests";

expectSemanticallySimilar(
  await chat("what's the refund policy?"),
  "Refunds are available within 30 days of purchase.",
  {
    threshold: 0.4, // default 0.6 (tight); 0.3-0.4 for paraphrased outputs
    label: "refund-policy-answer", // optional, shown on mismatch
  },
);
```

**Behavior.**
- Tokenizes both strings: lowercase, strip punctuation, drop
  stopwords. A small English seed list ships as default; pass
  `stopwords` for non-English or domain-specific corpora.
- Computes Jaccard similarity (intersection / union) over the token
  sets.
- Throws `SemanticMismatchError` with both texts + the computed
  similarity + the threshold when below the bar.
- The default threshold (0.6) is conservative — it's the floor for
  "the response is approximately the same answer." For testing
  across model upgrades or paraphrased prompts, drop it to 0.3–0.4.
- The math is intentionally simple (no embeddings, no stemming). For
  rigorous semantic eval, use `llm-eval-harness`'s judge layer; this
  helper is the test-runtime smoke check.

**Calibration.** A 5-minute exercise: take 20 outputs you'd consider
"approximately correct" and 20 outputs you'd consider "wrong," compute
the Jaccard scores against expected, and pick the threshold that
separates the two clouds. Document the chosen threshold in the test
file's header comment.

---

## How they compose

The three helpers cover three distinct failure axes; combining them
covers the realistic AI-feature test:

```typescript
import {
  expectSemanticallySimilar,
  waitFor,
  withRetryBudget,
} from "ai-app-integration-tests";

// 1. Retry around the flaky LLM call.
const response = await withRetryBudget(() => callTheLLM(), {
  maxAttempts: 3,
  backoffMs: 200,
});

// 2. Semantic assertion on the LLM output.
expectSemanticallySimilar(response, expectedAnswer, { threshold: 0.4 });

// 3. Bounded wait for the response to surface in the UI.
const surfaced = await waitFor(() => readUiResponse(), {
  timeoutMs: 5000,
  intervalMs: 100,
  label: "ui-response",
});
```

`test/demo-flake-patterns.test.ts` is the executable version of this
sketch — a fake flaky LLM, a delayed UI surface, all three helpers in
one realistic flow.

---

## What this isn't

- **Not an LLM-judge eval.** Use `llm-eval-harness` for rigorous,
  rubric-based scoring of LLM outputs against gold data. The
  semantic assertion here is a smoke check, not a quality metric.
- **Not a load test.** `withRetryBudget` smooths over transient
  failures; if your tests need to characterize p95 latency under
  concurrent load, use a real load tool against the same Backend
  Protocol the rest of the package exercises.
- **Not a replacement for the cassette layer.** When the LLM call
  needs to be *deterministic*, record a cassette. When the call is
  unavoidably non-deterministic (real-API smoke), wrap it in a retry
  budget and a semantic assertion.
