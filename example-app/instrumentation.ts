/**
 * Next.js instrumentation hook.
 *
 * Runs once per server boot, in both the dev and production builds. We
 * use it to install a deterministic Anthropic-API stub when the server
 * is started with ``ANTHROPIC_TEST_MODE=replay`` — the mode Playwright
 * tests run under.
 *
 * Why not the toolkit's ``installFromEnv()`` here:
 * - Playwright runs against a real Next.js server, so the cassette layer's
 *   request-hash needs to match exactly what the Anthropic SDK serializes.
 *   That's tractable but requires either a real recording (needs an API
 *   key budget) or hand-computed hashes that drift on SDK upgrades.
 * - For three deterministic UI streams (short / long / error), a tiny
 *   prompt-routed stub is simpler and lets the cassette layer keep its
 *   own scope (in-process route tests + recorder mode).
 *
 * Production behavior is unchanged: when ``ANTHROPIC_TEST_MODE`` is unset
 * or set to ``"live"`` the hook is a no-op and the real SDK runs.
 *
 * That sentence was accurate and *incomplete*, which is what made #101 easy
 * to miss: the hook used to be a no-op for every other value too. ``mode !==
 * "replay"`` treated a typo, a stray space and a set-but-empty variable as
 * "run against the real API", where the toolkit's ``installFromEnv`` throws
 * for the same input. It now shares one parse with a single stated domain —
 * see ``./test-mode``.
 */

import { parseTestMode } from "./test-mode";

export async function register() {
  // Default `"live"`, deliberately different from `installFromEnv`'s
  // `"replay"`: this runs on every production server boot, where installing a
  // stub would be far worse than not installing one. `parseTestMode` throws on
  // anything outside the three-value domain, so the *unsafe* fall-through is
  // gone while the safe default stays (#101).
  const mode = parseTestMode(process.env.ANTHROPIC_TEST_MODE, "live");
  if (mode !== "replay") return;

  const { installPlaywrightStub } = await import("./instrumentation-stub");
  installPlaywrightStub();
}
