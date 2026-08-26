/**
 * `ANTHROPIC_API_KEY`, read the same way in all three routes (#102).
 *
 * The three routes each did:
 *
 *     const apiKey = process.env.ANTHROPIC_API_KEY ?? "test-key";
 *
 * `??` fires on `null` / `undefined` only, so `ANTHROPIC_API_KEY=` — what
 * `docker run -e ANTHROPIC_API_KEY` with nothing after it produces, and what an
 * empty line in a `.env` file produces — reached the SDK as `""` rather than as
 * the intended placeholder. Measured against the real SDK constructor:
 *
 *     value        result
 *     "test-key"   constructed, apiKey = "test-key"
 *     ""           constructed, apiKey = ""       <- the fallback did not fire
 *     "   "        constructed, apiKey = "   "    <- nor here
 *
 * The SDK rejects none of them at construction, so the failure moves to request
 * time and arrives as a different error text than the one the placeholder was
 * chosen to produce.
 *
 * **This is a diagnostic fix, not a correctness one, and the issue says so.**
 * Under `ANTHROPIC_TEST_MODE=replay` the instrumentation stub intercepts
 * `globalThis.fetch` and the key is never used — which is the path the
 * `"test-key"` placeholder exists for. Outside it, `""` and `"test-key"` both
 * fail to authenticate. What is worth fixing is that "the fallback I wrote is
 * not the fallback that runs", repeated in three files.
 *
 * Same treatment `parseTestMode` in `./test-mode.ts` gives its own variable:
 * empty and whitespace-only are *unset*, not values. Trimming also means a
 * key pasted out of a CI YAML block with a trailing space behaves like the key
 * rather than like a different one.
 *
 * Deliberately NOT throwing on an empty value, unlike `parseTestMode`. An
 * unrecognized `ANTHROPIC_TEST_MODE` could mean a silent live run, which the
 * README forbids; an unset API key is the ordinary local-development state that
 * the placeholder exists to serve.
 */

/**
 * The placeholder used when no key is configured.
 *
 * Named so it reads in a stack trace or an SDK error: someone seeing this value
 * has not set `ANTHROPIC_API_KEY`, and is either in replay mode (where the key
 * is never sent) or has a real problem.
 */
export const PLACEHOLDER_API_KEY = "test-key";

/** Return `ANTHROPIC_API_KEY`, or the placeholder when it is unset or blank. */
export function readApiKey(raw: string | undefined = process.env.ANTHROPIC_API_KEY): string {
  const trimmed = (raw ?? "").trim();
  return trimmed.length === 0 ? PLACEHOLDER_API_KEY : trimmed;
}
