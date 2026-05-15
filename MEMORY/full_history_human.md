# Session History (human-readable)

Chronological log of work sessions. Most recent first below the divider.

---

## 2026-05-15 — Issue #1: deterministic Anthropic API replay
**Duration:** ~60 min · **Branch:** `session/2026-05-15-1207-issue-01`

- Shipped the toolkit end-to-end: `src/cassette.ts` (schema, normalization, hashing, redaction), `src/io.ts` (CassetteStore), `src/fetch-recorder.ts` (recorder + replayer wrappers around fetch), `src/install.ts` (`installFromEnv()` switching on `ANTHROPIC_TEST_MODE`), `src/index.ts` (public API).
- 24 hermetic vitest tests across three files: 17 unit tests on hashing/normalization/redaction, 6 end-to-end record-then-replay round-trips (non-streaming + SSE), 1 demo replaying a committed Anthropic-shaped cassette.
- Locked four cookbook decisions: D-002 (fetch monkey-patch over MSW), D-003 (hash on method+url+body, exclude headers), D-004 (mandatory redaction + CI rescan), D-005 (missing cassette throws).
- CI: `npm ci → lint → typecheck → test → build` plus a `no-leaked-secrets` job that re-scans every committed cassette against `sk-`/`sk-ant-`/`Bearer` regexes.
- Committed `fixtures/a154fc0b65d0d40c779b713bd7b65138.json` — a real Anthropic `/v1/messages` response shape, redacted, used by `test/demo.test.ts`.
- Backfilled README and `docs/architecture.md` with the request-flow diagram and the rationale for picking fetch-patch over MSW.

**Why this work, this session:** Every other test in this repo (#2 Playwright streaming tests, #4 example app) needs a way to call the Anthropic API deterministically without burning credits or flaking on rate limits. Issue #1 is that foundation; locking the four decisions now keeps subsequent issues from re-litigating the same tradeoffs.

**Open questions / blockers:** None. `npm audit` reports 7 moderate severity advisories from transitive dev-deps; not blocking, will revisit if a real exploit lands.

**Next session:** Issue #2 (Playwright tests for streaming UI states) — install the replayer in Playwright's `globalSetup`, exercise short / long / error stream paths against the example app from #4 once it lands.
