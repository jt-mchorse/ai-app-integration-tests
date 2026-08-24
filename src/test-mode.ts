/**
 * The `ANTHROPIC_TEST_MODE` value domain, stated once (#101).
 *
 * Two places read this variable, and they had drifted. `installFromEnv`
 * validated with a `switch` whose `default:` throws; `example-app`'s Next.js
 * instrumentation hook re-derived the rule as `if (mode !== "replay") return;`
 * — which treats a typo, a stray space and a set-but-empty variable as "run
 * against the real API". Measured across 13 values, the two disagreed on 8,
 * and every disagreement was in the unsafe direction.
 *
 * That is the behaviour the README calls forbidden: "silent fall-through to
 * live is forbidden", and "defaulting to `replay` so CI never accidentally
 * hits the real API".
 *
 * `example-app/` has its own `package.json` and does not depend on this
 * package, so it carries a mirrored copy at `example-app/test-mode.ts`.
 * `test/test-mode-parity.test.ts` locks the two together by *executing both*
 * over the same matrix — a differential test, not a text comparison — so the
 * copy cannot drift the way the hand-written check did.
 */

/** The three modes, in the order the README lists them. */
export const TEST_MODES = ["record", "replay", "live"] as const;

export type TestMode = (typeof TEST_MODES)[number];

/**
 * Parse `ANTHROPIC_TEST_MODE`, or throw naming the variable and the domain.
 *
 * `fallback` differs by caller **on purpose**, and the asymmetry is correct:
 *
 * - `installFromEnv` passes `"replay"`, because it is a test tool and the
 *   README's guarantee is that "CI never accidentally hits the real API".
 * - The instrumentation hook passes `"live"`, because it runs on *every*
 *   production Next.js server boot, where installing a stub would be far worse
 *   than not installing one.
 *
 * What must agree between the two is the treatment of a value that is not one
 * of the three. That is the half that had drifted — not the default.
 *
 * Empty and whitespace-only are treated as unset. `??` fires on `null` /
 * `undefined` only, so `ANTHROPIC_TEST_MODE=` arrived as `""` and fell
 * straight through the hook's `!== "replay"` check. Trimming also makes
 * `" replay"` out of a CI YAML block behave like `"replay"` rather than like
 * a typo — the previous behaviour was to throw here and to silently go live
 * there, which is the worst of both.
 */
export function parseTestMode(raw: string | undefined, fallback: TestMode): TestMode {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (trimmed.length === 0) return fallback;
  if ((TEST_MODES as readonly string[]).includes(trimmed)) return trimmed as TestMode;
  throw new Error(
    `ANTHROPIC_TEST_MODE must be ${TEST_MODES.map((m) => `"${m}"`).join(" | ")}; ` +
      `got ${JSON.stringify(raw)}. Refusing to guess: an unrecognized value used to ` +
      `mean "no stub installed" in example-app's instrumentation hook, i.e. a silent ` +
      `run against the real Anthropic API — which the README forbids.`,
  );
}
