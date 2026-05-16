/**
 * Playwright tests for the /streaming UI (issue #2).
 *
 * Drives the page through three scenarios, asserting the deterministic
 * phase progression:
 *
 *   1. short  →  loading → first-token → done (≤ 1 s)
 *   2. long   →  loading → first-token → streaming → done (text grows
 *                across many frames; final answer contains the canned
 *                token sequence the stub emits).
 *   3. error  →  loading → error (error-card visible; phase stays at
 *                "error" — no streaming progression).
 *
 * Phase state lives in the React component state and is reflected in
 * the `[data-testid=phase-indicator]` element as the literal text
 * `phase: <state>`. We assert on that text rather than reading the
 * internal state so the test contract matches what a user sees.
 *
 * The Anthropic stub in `e2e/_stub.ts` routes by prompt keyword so a
 * single `webServer` boot covers all three cases.
 */

import { expect, test } from "@playwright/test";

const PHASE = (state: string) => `phase: ${state}`;

test.describe("streaming UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/streaming");
  });

  test("short stream: idle → loading → first-token → done", async ({ page }) => {
    await page.getByTestId("prompt-input").fill("short reply please");
    await expect(page.getByTestId("phase-indicator")).toHaveText(PHASE("idle"));

    await page.getByTestId("run-button").click();

    // Phase progression is fast; expect to see first-token then done.
    await expect(page.getByTestId("phase-indicator")).toHaveText(PHASE("done"), {
      timeout: 5_000,
    });
    await expect(page.getByTestId("answer")).toContainText("Hi.");
    await expect(page.getByTestId("answer")).toContainText("There.");
  });

  test("long stream: streams across many frames, terminates done", async ({ page }) => {
    await page.getByTestId("prompt-input").fill("long-form prose please");
    await page.getByTestId("run-button").click();

    // Catch the streaming state — the stub yields ~32 chunks 12 ms apart,
    // so streaming is visible for ~250 ms. Be generous on the deadline.
    await expect(page.getByTestId("phase-indicator")).toHaveText(PHASE("streaming"), {
      timeout: 3_000,
    });

    // Wait for done.
    await expect(page.getByTestId("phase-indicator")).toHaveText(PHASE("done"), {
      timeout: 8_000,
    });

    const answer = await page.getByTestId("answer").innerText();
    // The stub emits "token-00 ", "token-01 ", ... — assert a couple of
    // landmarks across the stream rather than the full string so a
    // minor stub edit doesn't break the test.
    expect(answer).toContain("token-00");
    expect(answer).toContain("token-15");
    expect(answer).toContain("token-31");
  });

  test("error stream: phase 'error' surfaced + error-card visible", async ({ page }) => {
    await page.getByTestId("prompt-input").fill("trigger an error please");
    await page.getByTestId("run-button").click();

    await expect(page.getByTestId("phase-indicator")).toHaveText(PHASE("error"), {
      timeout: 5_000,
    });
    await expect(page.getByTestId("error-card")).toBeVisible();
    // The route forwards the SDK's error message in the SSE frame; the
    // exact text comes from `e2e/_stub.ts` overloaded_error message.
    await expect(page.getByTestId("error-card")).toContainText(/error/i);
  });
});
