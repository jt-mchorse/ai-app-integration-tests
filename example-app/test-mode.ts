/**
 * The `ANTHROPIC_TEST_MODE` value domain, in one place (#101).
 *
 * The toolkit's `src/install.ts::installFromEnv` already spells this domain
 * out in a `switch` with a `default:` that throws. `instrumentation.ts`
 * re-derived it as `if (mode !== "replay") return;` — and the two drifted
 * apart, on 8 of 13 measured values, in the unsafe direction every time:
 *
 *     value          instrumentation.register     installFromEnv
 *     ""             no-op -> LIVE SDK            THROWS
 *     "  "           no-op -> LIVE SDK            THROWS
 *     " replay"      no-op -> LIVE SDK            THROWS
 *     "replay "      no-op -> LIVE SDK            THROWS
 *     "repaly"       no-op -> LIVE SDK            THROWS
 *     "1" / "true" / "stub"
 *                    no-op -> LIVE SDK            THROWS
 *
 * A typo, a stray space out of a CI YAML block, or a set-but-empty variable
 * silently meant "run the Playwright suite against the real API" instead of
 * "install the deterministic stub" — which the README calls forbidden:
 * "silent fall-through to live is forbidden", and "defaulting to `replay` so
 * CI never accidentally hits the real API".
 *
 * `example-app/` has its own `package.json` and does not depend on the
 * toolkit, so this cannot literally import the canonical helper. It is a
 * MIRROR of `src/test-mode.ts`, and the root suite's
 * `test/test-mode-parity.test.ts` locks the two together by *executing both*
 * over the same matrix — a differential test, not a text comparison — so this
 * copy cannot drift the way the hand-written `!== "replay"` check did.
 *
 * If you change the rule here, change it there. The parity test will tell you
 * if you forget.
 */

/** The three modes, in the order the README lists them. */
export const TEST_MODES = ["record", "replay", "live"] as const;

export type TestMode = (typeof TEST_MODES)[number];

/**
 * Parse `ANTHROPIC_TEST_MODE`, or throw naming the variable and the domain.
 *
 * `fallback` differs by caller **on purpose**, and the asymmetry is correct:
 *
 * - `installFromEnv` defaults to `"replay"` because it is a test tool, and
 *   the README's guarantee is that "CI never accidentally hits the real API".
 * - This hook defaults to `"live"` because it runs on *every* production
 *   Next.js server boot, where installing a stub would be far worse than
 *   not installing one.
 *
 * What must agree between the two is the treatment of a value that is not one
 * of the three — that is the half that had drifted, not the default.
 *
 * Empty and whitespace-only are treated as unset: `??` fires on `null` /
 * `undefined` only, so `ANTHROPIC_TEST_MODE=` arrived as `""` and fell
 * straight through the `!== "replay"` check. Trimming also makes `" replay"`
 * out of a CI YAML block behave like `"replay"` rather than like a typo.
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
