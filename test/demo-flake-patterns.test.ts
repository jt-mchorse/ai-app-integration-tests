// Integration-style demo: all three flake-reduction helpers in one
// realistic flow.
//
// Scenario: a flaky LLM endpoint occasionally returns 503; once it
// succeeds, the response text is *similar* to the expected answer
// (LLM-style drift), and a downstream component takes a few polls
// to surface the answer in the UI state.
//
// This test is the executable version of `docs/patterns.md`'s
// composition example; the real assertions live in `support.test.ts`.

import { describe, expect, test } from "vitest";

import {
  expectSemanticallySimilar,
  waitFor,
  withRetryBudget,
} from "../src/support/index.js";

// A fake "LLM endpoint" that fails the first two calls with a 503 then
// returns a paraphrase of the expected answer.
function makeFlakyLLM(): () => Promise<string> {
  let calls = 0;
  return async () => {
    calls++;
    if (calls <= 2) {
      const err = Object.assign(new Error("upstream busy"), { status: 503 });
      throw err;
    }
    return "Sure — refunds are available for up to 30 days after the purchase.";
  };
}

// A fake "UI state" that surfaces the answer only after a few polls.
function makeDelayedUiState(answer: string): { read: () => string | null } {
  let polls = 0;
  return {
    read: () => {
      polls++;
      if (polls < 3) return null;
      return answer;
    },
  };
}

describe("demo: flake-reduction patterns compose", () => {
  test("retry budget recovers from transient 503; semantic check + waitFor confirm the result", async () => {
    const llm = makeFlakyLLM();
    // Step 1: bounded retry over the flaky endpoint.
    const response = await withRetryBudget(llm, {
      maxAttempts: 5,
      backoffMs: 1,
      sleep: async () => {},
    });

    // Step 2: semantic assertion on the LLM output. Exact wording will
    // drift across model versions; we want approximate match.
    expectSemanticallySimilar(
      response,
      "Refunds are available within 30 days of purchase.",
      { threshold: 0.4, label: "refund-policy-answer" },
    );

    // Step 3: a UI surface that polls the response in. Bounded wait
    // surfaces the value or fails with the last-observed null.
    const ui = makeDelayedUiState(response);
    let clock = 0;
    const surfaced = await waitFor(() => ui.read(), {
      timeoutMs: 1000,
      intervalMs: 5,
      label: "answer-visible",
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });

    expect(surfaced).toBe(response);
  });
});
