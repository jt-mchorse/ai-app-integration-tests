/**
 * Playwright tests for the /streaming UI (issue #2).
 *
 * Drives the page through three scenarios, asserting the deterministic
 * phase progression:
 *
 *   1. short  →  loading → first-token → streaming → done (≤ 1 s; the
 *                stub's two chunks are enough to reach "streaming").
 *   2. long   →  loading → first-token → streaming → done (text grows
 *                across many frames; final answer contains the canned
 *                token sequence the stub emits).
 *   3. error  →  loading → error (error-card visible; phase stays at
 *                "error" — no streaming progression).
 *
 * The progression is RECORDED, not polled for (#155). `toHaveText` re-checks
 * on Playwright's backoff (+0, 20, 70, 170, 270, 770 ms, then every 500 ms),
 * so a phase shown for ~400 ms can fall between two checks: 280 ms of extra
 * latency on `/api/streaming` made the old `toHaveText("phase: streaming")`
 * miss it. A MutationObserver installed before Run sees every commit, and the
 * tests assert the recorded order after the terminal phase. They do not
 * require every phase: two SSE frames that arrive in one read are one React
 * commit, so "first-token" can legitimately be skipped.
 *
 * Phase state lives in the React component state and is reflected in
 * the `[data-testid=phase-indicator]` element as the literal text
 * `phase: <state>`. We assert on that text rather than reading the
 * internal state so the test contract matches what a user sees.
 *
 * The Anthropic stub in `e2e/_stub.ts` routes by prompt keyword so a
 * single `webServer` boot covers all three cases.
 */

import { expect, test, type Page } from "@playwright/test";

const PHASE = (state: string) => `phase: ${state}`;

/** The documented order; a recorded sequence may skip states but never go back. */
const ORDER = ["idle", "loading", "first-token", "streaming", "done"].map(PHASE);

type Recorded = { __phases?: string[] };

/** Start recording every text the phase indicator shows; call before Run. */
async function recordPhases(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="phase-indicator"]');
    if (el === null) throw new Error("no phase-indicator to record");
    const seen = [(el.textContent ?? "").trim()];
    (window as unknown as Recorded).__phases = seen;
    new MutationObserver(() => {
      const text = (el.textContent ?? "").trim();
      if (seen[seen.length - 1] !== text) seen.push(text);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
}

async function phasesSeen(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as Recorded).__phases ?? []);
}

/** Starts at idle, ends at `last`, and every step moves forward in ORDER. */
function expectForwardProgression(seen: string[], last: string): void {
  expect(seen[0]).toBe(PHASE("idle"));
  expect(seen[seen.length - 1]).toBe(last);
  const ranks = seen.map((p) => ORDER.indexOf(p));
  expect(ranks.every((r) => r >= 0), `unknown phase in ${JSON.stringify(seen)}`).toBe(true);
  for (let i = 1; i < ranks.length; i++) {
    expect(ranks[i], `went backwards: ${JSON.stringify(seen)}`).toBeGreaterThan(ranks[i - 1]);
  }
}

test.describe("streaming UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/streaming");
  });

  test("short stream: idle → loading → first-token → done", async ({ page }) => {
    await page.getByTestId("prompt-input").fill("short reply please");
    await expect(page.getByTestId("phase-indicator")).toHaveText(PHASE("idle"));
    await recordPhases(page);

    await page.getByTestId("run-button").click();

    await expect(page.getByTestId("phase-indicator")).toHaveText(PHASE("done"), {
      timeout: 5_000,
    });
    expectForwardProgression(await phasesSeen(page), PHASE("done"));
    await expect(page.getByTestId("answer")).toContainText("Hi.");
    await expect(page.getByTestId("answer")).toContainText("There.");
  });

  test("long stream: streams across many frames, terminates done", async ({ page }) => {
    await page.getByTestId("prompt-input").fill("long-form prose please");
    await recordPhases(page);
    await page.getByTestId("run-button").click();

    await expect(page.getByTestId("phase-indicator")).toHaveText(PHASE("done"), {
      timeout: 8_000,
    });
    // "Streams across many frames": the DOM showed `streaming` at some point.
    // It lasts ~400 ms (the stub's ~32 chunks 12 ms apart), so it is read
    // from the recording rather than polled for (#155).
    const seen = await phasesSeen(page);
    expectForwardProgression(seen, PHASE("done"));
    expect(seen).toContain(PHASE("streaming"));

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
    await recordPhases(page);
    await page.getByTestId("run-button").click();

    await expect(page.getByTestId("phase-indicator")).toHaveText(PHASE("error"), {
      timeout: 5_000,
    });
    const seen = await phasesSeen(page);
    expect(seen).not.toContain(PHASE("streaming"));
    expect(seen).not.toContain(PHASE("done"));
    await expect(page.getByTestId("error-card")).toBeVisible();
    // The route forwards the SDK's error message in the SSE frame; the
    // exact text comes from `e2e/_stub.ts` overloaded_error message.
    await expect(page.getByTestId("error-card")).toContainText(/error/i);
  });

  // #135: a body that ends without a `done`/`error` frame used to leave the
  // phase at `streaming` (or `first-token`) for good, with Run disabled. The
  // route always sends one, so the response is substituted with page.route --
  // the shape a proxy timeout or a cut connection produces.
  for (const [label, body] of [
    ["two data frames, then close", 'data: {"text":"Hello"}\n\ndata: {"text":" world"}\n\n'],
    ["one data frame, then close", 'data: {"text":"Hello"}\n\n'],
    ["empty body", ""],
  ] as const) {
    test(`no terminal frame (${label}): lands in error and Run is enabled again`, async ({ page }) => {
      await page.route("**/api/streaming", (route) =>
        route.fulfill({ status: 200, contentType: "text/event-stream", body }),
      );
      await page.getByTestId("run-button").click();
      await expect(page.getByTestId("phase-indicator")).toHaveText(PHASE("error"), {
        timeout: 5_000,
      });
      await expect(page.getByTestId("error-card")).toContainText("stream ended before");
      await expect(page.getByTestId("run-button")).toBeEnabled();
    });
  }
});
