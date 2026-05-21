/**
 * Surface-2 helper for scripts/capture_demo.sh.
 *
 * Installs the replayer against a deliberately-empty fixtures dir and
 * issues a /v1/messages request. D-005 (missing cassette in replay
 * mode is fatal) means the call throws a MissingCassetteError; we
 * catch it, print the message, exit 0 — so the demo viewer sees the
 * actual error text rather than a silent fall-through to a live API
 * call.
 *
 * Invoked via `npx tsx scripts/missing_cassette_demo.ts` so the
 * script works on both the CI toolkit job (Node 20) and recording
 * engineers' laptops (any modern Node) without depending on
 * Node's native TypeScript support, and without depending on a
 * pre-built `dist/`. The capture script passes the empty fixtures
 * dir via `MISSING_CASSETTE_DEMO_FIXTURES`.
 */

import {
  MissingCassetteError,
  installFromEnv,
  uninstall,
} from "../src/index.js";

const fixturesDir = process.env.MISSING_CASSETTE_DEMO_FIXTURES;
if (!fixturesDir) {
  console.error(
    "MISSING_CASSETTE_DEMO_FIXTURES must be set (caller should pass an empty tempdir).",
  );
  process.exit(2);
}

// Force replay mode regardless of the caller's env. The whole point
// is to show what happens when a replay request misses.
process.env.ANTHROPIC_TEST_MODE = "replay";
installFromEnv({ fixturesDir });

try {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-test-key-do-not-use-1234567890abcdef",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64,
      messages: [{ role: "user", content: "unrecorded request" }],
    }),
  });
  console.log("UNEXPECTED: request succeeded with status", r.status);
  process.exit(3);
} catch (e) {
  uninstall();
  if (e instanceof MissingCassetteError) {
    console.log("caught MissingCassetteError — D-005 enforced:");
    console.log("  " + e.message);
    process.exit(0);
  }
  const err = e as { name?: string; message?: string };
  console.log("UNEXPECTED error:", err.name, err.message);
  process.exit(4);
}
