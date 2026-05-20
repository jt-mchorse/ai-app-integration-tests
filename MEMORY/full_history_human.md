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

## 2026-05-16 — Issue #4: Example Next.js 15 app under test
**Duration:** ~55 min · **Branch:** `session/2026-05-16-0346-issue-4`

- Shipped a Next.js 15 (App Router, React 19) example app under `example-app/` as a peer subproject (D-006) with its own `package.json` / `node_modules` / `tsconfig.json`. Toolkit root deps unchanged — no Next.js, no React, no Anthropic SDK leaked into the library install surface.
- Three LLM-driven screens, each backed by a tiny route handler under `app/api/*/route.ts`:
  - **`/streaming`** — POST a prompt; the route opens `client.messages.stream()` and forwards `text_delta` events as SSE frames. Client component renders tokens as they arrive with a deterministic phase indicator (`loading → first-token → streaming → done`).
  - **`/tools`** — POST a query; the route runs a two-turn loop with two tools (`get_weather` returning canned weather, `calculate` evaluating a sandboxed arithmetic expression — regex-gated against anything but digits/operators/parens so the tool stays deterministic). UI renders each tool call with input + result, then the final text answer.
  - **`/error`** — POST `{ kind: "validation"|"upstream"|"shape" }`; the route returns a structured error envelope. `validation` and `shape` paths return early without an upstream call; `upstream` triggers a real SDK error by pointing at a deliberately invalid model id. UI renders an error card with `type`, `status`, and `details`.
- 14 vitest tests under `example-app/test/`: 5 for streaming (route returns SSE; one data frame per text_delta in order; terminal `done` frame with `ms`; 400 on missing prompt / bad JSON), 5 for tools (calculate routing + math result, weather routing, sandbox rejection of non-arithmetic, 400 paths), 4 for error (validation envelope, shape envelope, unknown-kind rejection, invalid JSON). Tests call the route handlers directly with synthetic `Request`s — no Next.js server boot.
- Root `package.json` got `example:install`, `example:dev`, `example:build`, `example:test`, and `test:all` scripts that proxy into the subproject. CI gained an `example-app` job parallel to the existing `toolkit` job: `npm install` → `next build` → vitest. Toolkit job unchanged.
- Architecture doc gets a new "Example app under test (#4)" section documenting the route table, the test-handler-in-process pattern, and the quickstart commands. README "What this is" updated.
- D-007 — Next.js 15 App Router (not Pages) — documented for consistency with `nextjs-streaming-ai-patterns`.

**Why this work, this session:** Issue #2 (Playwright streaming tests) can't ship without an app to point at; without #4 it sits blocked indefinitely. The toolkit's replay layer (issue #1) is the right substrate for #2's tests to layer on top of, but it needs *something* under test that exercises the three failure modes the spec calls out (streaming, tool use, error). #4 is that substrate.

**Open questions / blockers:** None. The selection rule strictly picked #2 (lower number) but #2's first AC is "Tests cover three streams against the UI" — without the UI, #2 is vapor. Deviation documented in the plan comment and matches the previous session's #4-over-#3 deviation pattern. `npm audit` reports moderate-severity advisories in transitive Next.js deps; not blocking.

**Next session:** Issue #2 (Playwright tests) is now unblocked. Spin up the example app in Playwright's `webServer` config, install the replayer in `globalSetup`, run the three stream-state assertions against the screens this PR shipped.

## 2026-05-16 — Issue #2: Playwright tests for streaming UI states
**Duration:** ~45 min · **Branch:** `session/2026-05-16-1537-issue-2`

- Shipped three Playwright tests for the example-app's `/streaming` page covering the deterministic UI state machine: **short** (`idle → loading → first-token → done`, both canned chunks visible), **long** (32-chunk stream that exercises the `streaming` phase across many SSE frames; asserted text landmarks at `token-00`, `token-15`, `token-31`), and **error** (`phase: error` reached, error-card visible). Local: 3 passed in ~5 s — well under the 60 s acceptance budget.
- Backed by a Next.js `instrumentation.ts` hook (Next 15 standard) that runs once per server boot. Scoped to `ANTHROPIC_TEST_MODE=replay`; production behavior is unchanged when the env var is unset. The hook dynamic-imports `example-app/instrumentation-stub.ts`, which intercepts `globalThis.fetch` calls to `api.anthropic.com` and routes by keyword in the user prompt to one of three canned SSE streams. Uses the minimum SSE event sequence the `@anthropic-ai/sdk` needs (`message_start` → `content_block_start` → repeated `content_block_delta` → `content_block_stop` → `message_stop`); inter-frame delay is real (`await setTimeout`) so the client phase machine observes the same transition shape it would against a live model.
- D-008: chose the prompt-keyword stub over the toolkit's cassette layer for this issue. Hand-authoring a cassette requires matching the SDK's exact request body hash, which drifts on every SDK upgrade. The stub is ~150 lines and hash-drift-free; the cassette layer keeps its own scope (in-process vitest route tests + recorder mode). Reversible — a future Playwright issue that needs real recorded conversations can switch the instrumentation hook to `installFromEnv()` in four lines.
- CI: new `playwright` job alongside `toolkit` / `example-app`. Caches `~/.cache/ms-playwright` keyed on `@playwright/test` version so post-cache runs skip the ~100 MB Chromium download. Builds Next.js in production mode (`next build` then `next start -p 3100`) and runs `playwright test` against it. Failed runs upload `test-results/` as a 7-day artifact.
- 38 existing tests (24 root vitest + 14 example-app vitest) stay green; typecheck and lint clean.
- README "Patterns" section gets a "Playwright tests for streaming UI (#2)" subsection documenting the three-stream pattern, the `instrumentation.ts` hook, and the local run command.

**Why this work, this session:** Issue #2 was the only `priority:high` open in this repo; the example-app substrate (#4) had landed last session, so the Playwright layer was the next unblocked deliverable. Closing it lets the cookbook-style examples in #1 (test patterns) point to a concrete, green-on-CI Playwright suite instead of a placeholder.

**Open questions / blockers:** None blocking. Cross-browser coverage (Firefox / WebKit) is a deliberate follow-up — the issue is scoped to "stable on ubuntu-latest" and chromium-only meets that. Tools-route and error-route Playwright tests are separate issues that would build on the same `instrumentation.ts` / stub pattern.

**Next session:** No more `priority:high` open in this repo. Either a `priority:med` here (test pattern docs, additional route coverage) or another repo per the multi-issue loop.

## 2026-05-17 — Issue #3: Flake-reduction patterns
**Duration:** ~35 min · **Branch:** `session/2026-05-17-2333-issue-3`

- Shipped three composable test-runtime helpers under `src/support/`:
  - **`withRetryBudget(fn, policy)`** — bounded retries with a caller-supplied `classify` callback. Default classifier treats `AbortError` + `TimeoutError` + `ECONNRESET/REFUSED/TIMEDOUT/ENOTFOUND` + `"fetch failed"` + HTTP 429 + 5xx as flake; everything else hard. Hard errors short-circuit; flake errors consume the budget. Exhaustion throws `RetryBudgetExhaustedError` carrying the last underlying error and attempt count. Backoff = `backoffMs × multiplier^(attempt-1)`; multiplier defaults to 2.0. `sleep` is pluggable so unit tests drive it synchronously. `onAttempt` observer surfaces every failure for diagnostics.
  - **`waitFor(predicate, options)`** — time-bounded polling. Resolves with the predicate's first truthy value; on timeout throws `WaitTimeoutError` with the elapsed time, an operator-supplied `label`, and the last predicate value attached. The final sleep interval is capped to the remaining budget so the deadline fires at the documented moment, not `intervalMs` past it. Both `sleep` and `now` injectable.
  - **`expectSemanticallySimilar(actual, expected, opts)`** — Jaccard similarity over normalized tokens (lowercase, strip punctuation, drop stopwords). Default threshold 0.6 (tight; "approximately the same answer"). Throws `SemanticMismatchError` with both texts + the computed similarity + the threshold on mismatch. Custom stopwords accepted; pure-TS, no embedding dependency.
- Recorded D-009: flake classification is a caller-supplied callback rather than a thrown-class hierarchy. Same single-method-protocol seam pattern as the rest of the portfolio. Reversibility: cheap.
- `docs/patterns.md` — per-helper writeup (failure mode, API, behavior, when-not-to-use) plus a composition rule section and a calibration note for the semantic-assertion threshold. `test/demo-flake-patterns.test.ts` is the executable version of the composition example: flaky LLM (503 twice then succeeds) → retry budget recovers → semantic assertion on the paraphrased response → `waitFor` polls a delayed UI surface.
- 25 new tests in `test/support.test.ts` covering: retry budget returns on first success, retries flake then succeeds, hard errors short-circuit, exhaustion wraps with `RetryBudgetExhaustedError`, backoff multiplier grows the sleep, caller classifier overrides default, onAttempt observer is called for every failure, invalid policy rejected; default classifier categorizations across network/429/5xx/other; waitFor resolves on first truthy, throws with last value on timeout, awaits async predicates, caps the final sleep, rejects invalid timing options; semantic-assert passes on near-duplicate text, fails on unrelated text, error carries metadata, threshold knob raises/lowers the bar, invalid thresholds rejected, tokenize lowercase/strip/dropstops, custom stopwords replace default, Jaccard returns 1 for two empty bags, 1 for identical bags, intersection/union math. Plus the 1-test integration demo. Suite total 49 vitest (was 24), Playwright unchanged. Typecheck + lint clean.
- Public surface widened: root `src/index.ts` re-exports all three helpers + their error classes + types.
- README adds a `Flake-reduction patterns (#3)` section with a short code snippet showing all three composed; points at `docs/patterns.md` for the full writeup.

**Why this work, this session:** Issue #3 is a tightly-scoped 60-min issue that complements the existing cassette-based determinism layer — together they cover "deterministic when you can record, robust when you can't." With it shipped, the repo gains the test-runtime tools the example app (and any downstream caller) needs for non-cassette flows; the remaining `priority:med` issue (#5 CI tuning) requires actual CI metrics, which this session deliberately didn't tackle.

**Open questions / blockers:** None. The composition rule (retry → assert → wait) is documented + demoed; the calibration exercise for the semantic threshold is documented inline. A follow-up could add a stemming option to the tokenizer, but that's a polish item, not a blocker.

**Next session:** Issue #5 (sub-5-min CI) is the last `priority:med` open. Or loop to a different repo per the multi-issue prompt.

## 2026-05-18 — Issue #5: CI suite under 5 minutes total
**Duration:** ~25 min · **Branch:** `session/2026-05-18-issue-05` · **PR:** #10

- Restructured `.github/workflows/ci.yml` for sub-5-minute warm-cache wall time: added npm cache to the previously-uncached `example-app` job (the biggest single win), cached `example-app/.next/cache` on both Next-building jobs keyed on the lockfile + every file under `app/`, `lib/`, `components/` with `restore-keys` fallback, swapped every `npm install` for `npm ci`, and added a workflow-level `concurrency` group that cancels stale push-on-push runs.
- Each job ends with a per-job timing step that emits a duration `::notice` and writes a `**job:** Ns` row to `$GITHUB_STEP_SUMMARY`. The playwright row also reports `pw-cache-hit=true|false`. The "under 5 min" goal is now visible in the run's Summary tab — no log scrolling.
- New `docs/ci-timing.md` documents each cache, its key, what it skips, the expected warm-hit savings, and the invalidation rules of thumb. README gets a one-line `CI wall-time target: < 5 min on warm-cache runs` next to the existing CI badge, linked to the timing doc.
- D-010 records the GitHub-Actions-built-ins-only posture and the per-job-summary-row visibility decision.

**Why this work, this session:** #5 was the only remaining med-priority issue in the repo and a natural fit for a contained session. The "5 consecutive runs under 5 min" acceptance is post-merge — the PR is the *instrumentation* that makes verification cheap.

**Open questions / blockers:** The PR body explicitly flags that the 5-runs-under-5-min acceptance can't be closed inside the PR. JT (or the next session) should watch the Step Summary on the next 5 runs after merge and close the issue when the data lands.

**Next session:** Loop is at 4 shipped issues (plus one blocked-on-data skip). Budget allows for more — likely targets: nextjs-streaming-ai-patterns #5 (error recovery mid-stream) or a smaller cookbook issue. Will pick from build sequence next.

## 2026-05-18 — Issue #11: README truth pass + count-drift guard

**Duration:** ~20 min · **Branch:** `session/2026-05-18-2330-issue-11`

- Removed three stale fragments. "What this is" still framed #4 as "this layer" (PR-relative wording); rewritten as past tense describing today's full shipped set (toolkit + cassette, Playwright streaming tests, flake-reduction helpers, example app, sub-5-min CI). Quickstart had `# 24 tests pass — fully hermetic` hard-coded; real count drifted to 49 already; replaced with `# full hermetic vitest suite passes — no API key needed`. Demo section claimed the 60s capture was "pending the example app (#4)" — #4 closed; reframed to describe today's two-command runnable demo (`npm test` + Playwright e2e against the deterministic Anthropic stub) and tracked the captured asset as low-priority #12.
- Added `test/readme-snapshot.test.ts` (6 tests). Three invariants: every example-app / src / test path the README cites exists on disk, every `npm run <name>` invocation resolves to a real script in the appropriate `package.json`, and no bash code fence contains a `# <N> tests` comment. The third is the drift-mode-specific guard — the failure path was verified by reverting the Quickstart comment to a count-bearing form and watching the test fire with `bash fence contains a hard-coded test-count comment: # 24 tests`.
- 49 → 55 tests. `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all clean.

**Why this work, this session:** Closing the loop on today's portfolio-wide README hygiene pass — five other repos (`llm-cost-optimizer`, `prompt-regression-suite`, `rag-production-kit`, `nextjs-streaming-ai-patterns`, `agent-orchestration-platform`, `mcp-server-cookbook`) had matching drift modes fixed earlier in the day with similar snapshot/check tests. Catching the test-count drift in a dedicated guard means the future cleanup pass for *this* repo won't need to re-litigate the same lesson.

**Open questions / blockers:** Captured 60s asset still pending — owned by #12. Best done with screen-capture tooling rather than in an autonomous session.

**Next session:** Substantive feature work for this repo is done. Open issues are now #12 (low) only.

## 2026-05-20 — Issue #14: lock public surface (TS variant, library shape with `exports` field)
**Duration:** ~15 min · **Branch:** `session/2026-05-20-0351-issue-14`

- Added `test/public-surface.test.ts` (vitest, 4 test definitions → 8 test items after `it.each` over 5 README names). Third TS variant of the portfolio-wide hygiene pattern. This repo is shape-equivalent to `agent-orchestration-platform` (library with `src/index.ts` + dist build target), so the template was largely copy-paste; the only swap is `package.json#exports["."].import` instead of `package.json#bin` as the dist source-of-truth. Four axes: pkg version semver, every value export from `src/index.ts` defined and non-null at runtime, 5 README-quoted import names resolve (`installFromEnv`, `uninstall`, `expectSemanticallySimilar`, `waitFor`, `withRetryBudget`), exports field maps to `src/index.ts` via tsconfig `rootDir=src`/`outDir=dist`.
- Tamper-verified three axes: bad version, drop `installFromEnv,` line from `src/index.ts` re-exports (fires both value-exports and README-quickstart tests), bad exports target (`./dist/index-renamed.js`).
- Full suite 63/63 (was 55; +8 new), typecheck + lint clean.

**Why this work, this session:** Twelfth strike of the portfolio-wide public-surface hygiene pattern (9 Python + 3 TS). Completes coverage of every Python and TypeScript package surface in the portfolio.

**Open questions / blockers:** None — PR ready for review.

**Next session:** The TypeScript servers in `mcp-server-cookbook` (3 TS MCP servers) would need a separate pattern (`tsd` or `tsc --noEmit` snapshot) and are the only remaining un-locked TS surface; that's a follow-up effort.
