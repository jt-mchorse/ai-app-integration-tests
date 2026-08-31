/**
 * One rule for reading an environment variable: trim it, and treat a blank
 * value as unset (#107).
 *
 * `parseTestMode` (`src/test-mode.ts`, #101) already implements this rule for
 * `ANTHROPIC_TEST_MODE`. `scripts/missing_cassette_demo.ts` did not — it
 * guarded with a bare `!fixturesDir`, which is `false` for `"  "`, so a
 * whitespace-only value passed the guard and reached
 * `installFromEnv({ fixturesDir: "  " })`: a fixtures directory literally
 * named two spaces. Unset and `""` were both correctly refused, which is
 * exactly what makes the gap quiet — the two cases anyone would test by hand
 * behave, and the one that arrives from a `.env` line or a shell variable does
 * not.
 *
 * Same shape as `agent-orchestration-platform#131`, where two `PORTFOLIO_ROOT`
 * readers carried `!root || root.length === 0` and a padded-but-valid path
 * became a relative path under a directory named two spaces.
 *
 * ### Why `parseTestMode` does not import this
 *
 * `src/test-mode.ts` and `example-app/test-mode.ts` are a deliberate mirrored
 * pair: the example app is standalone and structurally cannot import from
 * `src/`, and `test/test-mode-parity.test.ts` exists to hold the two
 * hand-written copies to one behaviour by executing both over the same matrix.
 * Making one of them import a helper the other cannot would leave the pair
 * harder to eyeball-compare while buying nothing that parity test does not
 * already guarantee.
 *
 * So the two implementations of this rule are kept honest the same way the
 * mirrored pair is — by a differential test over one input matrix
 * (`test/env-blank-rule-parity.test.ts`), not by a shared import.
 */

/**
 * The trimmed value of `raw`, or `undefined` when it is unset or blank.
 *
 * Returning the *trimmed* value is half the rule and not a detail: rejecting
 * blanks while handing the caller back the untrimmed string would fix the
 * rejection and keep the broken path. The realistic input is not `"  "` on its
 * own — it is a correct path carrying incidental whitespace from a `.env`
 * line, a YAML value, or `$(cat path.txt)`.
 */
export function nonBlankEnv(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? "").trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The trimmed value of `process.env[name]`, or `undefined` when it is unset or
 * blank.
 *
 * `env` is injectable so a test can exercise the rule without mutating the
 * process — the parity test below does exactly that.
 */
export function readNonBlankEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return nonBlankEnv(env[name]);
}
