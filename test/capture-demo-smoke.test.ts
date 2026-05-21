/**
 * Smoke test for `scripts/capture_demo.sh` (issue #12).
 *
 * The capture script is the deterministic driver for the 60-second
 * README demo. JT records the GIF/video while it runs; this test runs
 * the script with `CAPTURE_PACE_SECONDS=0 CAPTURE_SKIP_E2E=1` and
 * pins the surfaces' contracts so the demo can't bitrot the same way
 * `readme-snapshot.test.ts` already protects the README in
 * isolation.
 *
 * Why CAPTURE_SKIP_E2E=1 here: surface 3 invokes
 * `npm run test:e2e --prefix example-app` which needs Playwright
 * browsers. The toolkit CI job (where this test runs) doesn't install
 * them — that's the dedicated `playwright` job's role. Surface 3's
 * skip path is what we assert; the recording engineer (or anyone with
 * chromium installed) gets the full three-surface run by invoking the
 * script without that env var.
 *
 * Contract this test pins:
 *
 * 1. The script exits 0 on a fresh clone with no API key.
 * 2. Each of the three surfaces fires (banner + the surface's
 *    distinctive output line both appear).
 * 3. Surface 2 actually catches a `MissingCassetteError` and prints
 *    the D-005 error text — proves the failure mode is exercised,
 *    not just claimed.
 * 4. Surface 3 prints the explicit skip line in CAPTURE_SKIP_E2E
 *    mode (so an accidental removal of the skip branch fires here).
 *
 * The script's tempdir cleanup runs via EXIT trap, so a failed
 * assertion here doesn't leave fixtures dirs behind.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "capture_demo.sh");

interface CaptureResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

let cached: CaptureResult | undefined;

function runCapture(): CaptureResult {
  if (cached !== undefined) return cached;
  if (!existsSync(SCRIPT)) {
    throw new Error(`missing ${SCRIPT}`);
  }
  const result = spawnSync("bash", [SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CAPTURE_PACE_SECONDS: "0",
      CAPTURE_SKIP_E2E: "1",
    },
    encoding: "utf8",
    // Surface 1's two vitest files run in ~350 ms; surface 2's tsx
    // call adds ~1-2 s; total well under 30 s on a laptop. 60 s
    // cap is headroom for slower CI.
    timeout: 60_000,
  });
  cached = {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
  return cached;
}

describe("scripts/capture_demo.sh", () => {
  it("exists and is executable", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const mode = statSync(SCRIPT).mode & 0o111;
    expect(mode).not.toBe(0);
  });

  it("exits 0 on a fresh clone with no API key", () => {
    const r = runCapture();
    if (r.status !== 0) {
      console.error("capture stdout:\n" + r.stdout);
      console.error("capture stderr:\n" + r.stderr);
    }
    expect(r.status).toBe(0);
  });

  it("fires surface 1 (cassette replay) with a passing vitest summary", () => {
    const r = runCapture();
    expect(r.stdout).toContain("surface 1: cassette replay");
    // The "Test Files … 2 passed" header is what vitest writes when
    // surface 1's two test files both pass. We pin the distinctive
    // tokens separately (rather than a regex with `\s+`) because
    // vitest's CI reporter sometimes inserts non-`\s`-matching
    // characters between header words. `toContain` is also what the
    // sister repos' smoke tests use for the same reason.
    expect(r.stdout).toContain("Test Files");
    expect(r.stdout).toContain("2 passed");
    expect(r.stdout).toContain("test/demo.test.ts");
    expect(r.stdout).toContain("test/record-replay.test.ts");
  });

  it("fires surface 2 (missing cassette) and prints the D-005 error text", () => {
    const r = runCapture();
    expect(r.stdout).toContain("surface 2: missing cassette is fatal");
    // The exact "caught MissingCassetteError — D-005 enforced:" line
    // comes from scripts/missing_cassette_demo.ts; the "no cassette
    // found" + "In replay mode this is fatal" text comes from
    // src/fetch-recorder.ts's MissingCassetteError constructor. Both
    // assertions guard against the helper or the error message
    // drifting.
    expect(r.stdout).toContain("caught MissingCassetteError");
    expect(r.stdout).toContain("no cassette found");
    expect(r.stdout).toContain("In replay mode this is fatal");
  });

  it("fires surface 3 and skips it explicitly under CAPTURE_SKIP_E2E=1", () => {
    const r = runCapture();
    expect(r.stdout).toContain("surface 3: Playwright e2e");
    expect(r.stdout).toContain("surface 3 skipped: CAPTURE_SKIP_E2E=1");
  });

  it("prints the closing banner", () => {
    const r = runCapture();
    expect(r.stdout).toContain("demo complete");
  });
});
