// Snapshot test for docs/architecture.md (#18).
//
// Before #18, the architecture doc was frozen at the substrate-only PR:
// the directory diagram listed src/ as 5 files and test/ as 3 (current
// reality: 6 and 8 plus a src/support/ flake-reduction subdir), the
// Example-app section said "Playwright tests are #2's scope, this PR
// ships the substrate" (Playwright shipped in #2 CLOSED on 2026-05-21,
// with example-app/e2e/streaming.spec.ts committed), and the "What
// this layer is NOT" section said the toolkit is "not a flake-reduction
// library" (flake-reduction shipped as src/support/{retry-budget,
// semantic-assert, wait-for}.ts and is documented in the README).
//
// This test locks the doc against re-drifting:
//
//   1. Every src/<file>.ts, src/support/<file>.ts, test/<file>.ts,
//      example-app/e2e/<file>.ts path token in the doc resolves on disk.
//   2. Four banned phrases — the exact shapes of pre-#18 staleness —
//      are absent. Matched case-insensitively so a future copy with
//      slight capitalization is still caught.
//   3. The doc references at least one src/support/ path and at least
//      one example-app/e2e/ path, so the inverse drift (someone trims
//      the diagram back to the substrate shape) also fails loudly.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const ARCH_PATH = resolve(ROOT, "docs/architecture.md");

// Exact substrings the pre-#18 doc carried that signaled drift. Each is
// the load-bearing fragment of one of the four stale claims.
const BANNED_PHRASES: ReadonlyArray<string> = [
  "Not a Playwright test runner",
  "Not a flake-reduction library",
  "Playwright tests on streaming UI states are issue",
  "This PR ships the substrate",
] as const;

/**
 * Extract path-like tokens from a markdown source. Catches:
 *   - src/foo.ts, src/support/foo.ts
 *   - test/foo.test.ts
 *   - example-app/e2e/foo.spec.ts (and other example-app subpaths)
 *
 * Tree-diagram-only entries (no leading slug, e.g. just "support/")
 * are intentionally not matched — the diagram is one source of refs,
 * but the doc text outside the fence is the canonical surface and
 * must reference paths in their slug-prefixed form for coverage.
 */
function pathTokens(md: string): string[] {
  const re = /(?:src|test|example-app)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|json|md)/g;
  const found = new Set<string>();
  for (const m of md.matchAll(re)) {
    found.add(m[0]);
  }
  return [...found].sort();
}

describe("docs/architecture.md is current with shipped scope (#18)", () => {
  const md = readFileSync(ARCH_PATH, "utf8");

  it("every src/, test/, example-app/ path token in the doc resolves on disk", () => {
    const tokens = pathTokens(md);
    expect(tokens.length, "expected the doc to reference at least one path").toBeGreaterThan(0);
    const missing = tokens.filter((t) => !existsSync(resolve(ROOT, t)));
    expect(
      missing,
      "architecture doc references paths that don't exist on disk: " +
        `${JSON.stringify(missing)}. Either fix the path or, if a file was ` +
        "intentionally renamed, update both the doc and any test that anchors on it.",
    ).toEqual([]);
  });

  it.each(BANNED_PHRASES)(
    "does not contain the stale phrase %j",
    (phrase: string) => {
      const lower = md.toLowerCase();
      const needle = phrase.toLowerCase();
      expect(
        lower.includes(needle),
        `architecture doc contains banned phrase "${phrase}", which was a ` +
          "specific shape of pre-#18 drift. If a different context legitimately " +
          "requires this string (e.g., a quoted example of what the doc used to " +
          "say), refactor the surrounding prose, or update BANNED_PHRASES with a comment.",
      ).toBe(false);
    },
  );

  it("BANNED_PHRASES is the exact set of four shapes from #18", () => {
    // Hard-pin so a future loose edit of this test can't silently drop one.
    expect([...BANNED_PHRASES]).toEqual([
      "Not a Playwright test runner",
      "Not a flake-reduction library",
      "Playwright tests on streaming UI states are issue",
      "This PR ships the substrate",
    ]);
  });

  it("doc references at least one src/support/ path (flake-reduction shipped)", () => {
    expect(
      md,
      "docs/architecture.md must reference at least one path under src/support/ — " +
        "the flake-reduction helpers ship today (retry-budget, semantic-assert, wait-for) " +
        "and are part of the core surface, not downstream concerns.",
    ).toMatch(/src\/support\//);
  });

  it("doc references at least one example-app/e2e/ path (Playwright shipped)", () => {
    expect(
      md,
      "docs/architecture.md must reference at least one path under example-app/e2e/ — " +
        "Playwright streaming tests shipped under #2 and live in example-app/e2e/, " +
        "not as a future / downstream concern.",
    ).toMatch(/example-app\/e2e\//);
  });
});
