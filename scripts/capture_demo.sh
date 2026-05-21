#!/usr/bin/env bash
# Deterministic driver for the 60-second README demo (issue #12).
#
# Runs the three demo surfaces in sequence on a fresh clone with no
# API key:
#
#   1. cassette replay         — `npx vitest run test/demo.test.ts
#                                test/record-replay.test.ts` exercises
#                                the install-from-env + replay flow
#                                against the committed
#                                /v1/messages cassette, plus the
#                                record→replay round-trip (D-002,
#                                D-003). The two test files are passed
#                                by path explicitly so this surface
#                                doesn't recurse with the smoke test.
#
#   2. missing cassette error  — an inline node script installs the
#                                replayer against an empty fixtures
#                                dir and issues a request. D-005
#                                makes that fatal — the script catches
#                                the MissingCassetteError and prints
#                                its message so the demo viewer sees
#                                the actual "no cassette found …
#                                In replay mode this is fatal …"
#                                string. Exit-suppressed with `|| true`
#                                because the throw is the success
#                                criterion.
#
#   3. Playwright e2e          — `npm run test:e2e --prefix example-app`
#                                drives the three example-app screens
#                                against the deterministic Anthropic
#                                stub installed by the example-app's
#                                `instrumentation.ts` (D-008). Auto-
#                                skipped with a clear banner when
#                                Playwright's chromium hasn't been
#                                installed locally (detected via
#                                `~/.cache/ms-playwright` and the
#                                node_modules check), so the toolkit
#                                CI job can run this script without
#                                needing browsers.
#
# The output is the recording — when JT records the GIF/video, this
# script's stdout (plus the actual stack trace from surface 2) is
# what gets captured. Hermetic: no API key, no network, no committed
# artifacts touched.
#
# Variables:
#   CAPTURE_PACE_SECONDS  pause between sections (default 2 for
#                         recording; test/capture-demo-smoke.test.ts
#                         sets this to 0).
#   CAPTURE_SKIP_E2E      "1" to force-skip surface 3 even if
#                         chromium is installed. Used by the smoke
#                         test so the toolkit CI job (no Playwright)
#                         can run this script end-to-end.
#
# Exit: 0 on full success; non-zero on any surface failure that isn't
# the expected MissingCassetteError throw in surface 2.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACE="${CAPTURE_PACE_SECONDS:-2}"

banner() {
  printf '\n'
  printf '═══ %s\n' "$1"
  printf '\n'
}

pace() {
  if [ "$PACE" != "0" ]; then
    sleep "$PACE"
  fi
}

cd "$REPO_ROOT"

banner "ai-app-integration-tests · 60-second demo"
printf 'three surfaces · cassette replay · missing-cassette failure mode · Playwright e2e\n'
printf 'no API key · no network · hermetic on a fresh clone\n'
pace

# ─── surface 1 ────────────────────────────────────────────────────────
banner "surface 1: cassette replay (D-002, D-003)"
printf 'npx vitest run test/demo.test.ts test/record-replay.test.ts\n'
printf '(install-from-env + replay against committed cassette + record→replay round-trip)\n\n'
npx vitest run test/demo.test.ts test/record-replay.test.ts --reporter=default
pace

# ─── surface 2 ────────────────────────────────────────────────────────
banner "surface 2: missing cassette is fatal (D-005)"
printf 'In replay mode an unrecorded request must throw, not silently fall through.\n'
printf 'This inline demo installs the replayer against an empty fixtures dir and\n'
printf 'fetches /v1/messages — D-005 guarantees you see this error rather than a\n'
printf 'live API call slipping through.\n\n'

# A scratch fixtures dir with no cassettes. The mkstemp-style mktemp -d
# gives us a unique path; trapped on EXIT in case the inline node call
# fails before our explicit cleanup.
EMPTY_FIX="$(mktemp -d -t aai-empty-fixtures-XXXXXX)"
trap 'rm -rf "$EMPTY_FIX"' EXIT INT TERM

set +e
MISSING_CASSETTE_DEMO_FIXTURES="$EMPTY_FIX" npx tsx scripts/missing_cassette_demo.ts 2>&1
SURFACE2_RC=$?
set -e

if [ "$SURFACE2_RC" != "0" ]; then
  printf '\n[capture] surface 2 exited %s; expected 0 (caught MissingCassetteError)\n' "$SURFACE2_RC" >&2
  exit 1
fi
pace

# ─── surface 3 ────────────────────────────────────────────────────────
banner "surface 3: Playwright e2e against the instrumentation stub (D-008)"

if [ "${CAPTURE_SKIP_E2E:-0}" = "1" ]; then
  printf 'surface 3 skipped: CAPTURE_SKIP_E2E=1 set (smoke-test mode).\n'
  printf 'run `npm run test:e2e --prefix example-app` directly for the full recording.\n'
elif ! [ -d "$HOME/.cache/ms-playwright" ] && ! [ -d "example-app/node_modules/@playwright/test/.local-browsers" ]; then
  printf 'surface 3 skipped: Playwright chromium not detected at ~/.cache/ms-playwright\n'
  printf 'or example-app/node_modules/@playwright/test/.local-browsers.\n'
  printf 'install once with: npx --prefix example-app playwright install chromium\n'
else
  printf 'npm run test:e2e --prefix example-app\n'
  printf '(three streaming-UI states against the deterministic Anthropic stub installed by example-app/instrumentation.ts)\n\n'
  npm run test:e2e --prefix example-app
fi
pace

banner "demo complete"
printf 'all surfaces hermetic on a fresh clone. record this stdout for the README GIF/video.\n'
