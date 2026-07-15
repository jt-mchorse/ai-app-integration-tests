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

## 2026-05-21 — Issue #12: 60-second walkthrough capture (script + smoke test; binary deferred to #16)
**Duration:** ~25 min · **Branch:** `session/2026-05-21-2323-issue-12` · **PR:** to be opened

- Added `scripts/capture_demo.sh` — bash driver, three surfaces. (1) `npx vitest run test/demo.test.ts test/record-replay.test.ts` shows the cassette replay flow + record→replay round-trip without recursing with the smoke test. (2) `scripts/missing_cassette_demo.ts` (invoked via `npx tsx`) installs the replayer against an empty fixtures dir and fetches `/v1/messages`, catches the real `MissingCassetteError` from `src/fetch-recorder.ts`, prints its message — D-005 is *demonstrated*, not just claimed. (3) `npm run test:e2e --prefix example-app` runs the Playwright streaming suite against the deterministic Anthropic stub (D-008); auto-skipped with a clear banner when chromium isn't installed locally, so the toolkit CI job can run the script.
- Added `test/capture-demo-smoke.test.ts` — 6 vitest tests. `spawnSync` the bash script with `CAPTURE_PACE_SECONDS=0 CAPTURE_SKIP_E2E=1`, assert exit 0, assert each surface's banner + distinctive output line. Surface 2 assertions pin both the helper's "caught MissingCassetteError" line AND the "no cassette found" / "In replay mode this is fatal" substrings from the error message — drift in either fires the test. Surface 3 assertion pins the explicit skip line. Tamper-verified: changing the surface 1 banner fires the matching assertion; reverted clean.
- Added `tsx` as a root devDep so surface 2's helper runs on Node 20 (CI) and Node 25 (local) alike without depending on a pre-built `dist/`. Extended `eslint.config.js` to include `scripts/**/*.ts` so the helper's type assertion parses.
- README "Demo" section: replaced the "pending" paragraph with the `bash scripts/capture_demo.sh` walkthrough explaining all three surfaces, the mode-pill / chromium prerequisite, and the binary-commit split to #16. `readme-snapshot.test.ts` still passes — the new `npm run test:e2e --prefix example-app` reference resolves to a real script in `example-app/package.json`, and the new bash fence carries no hard-coded test-count comment.
- Filed follow-up #16 — "run the script, ffmpeg-optimize the output, commit `docs/demo.{webm,mp4,gif}`, embed in README." Estimated 30 min, ridden by D-011.
- New core decision **D-011** — capture-via-deterministic-script-binary-deferred-to-followup. Mirrors D-012 in `nextjs-streaming-ai-patterns` and equivalent decisions in 5 sister repos earlier today. Full suite 69/69, typecheck + lint clean.

**Why this work, this session:** Seventh and last repo to land the `scripts/capture_demo.*` pattern today. Closes the script side of this repo's "Demo" quality-bar item. After this, every portfolio repo has the same capture-script pattern as the canonical answer to the README "Demo" placeholder, with binary recordings tracked as a per-repo low-priority follow-up.

**Open questions / blockers:** None for the engineering. #16 is a 30-min operational task gated on local Playwright chromium + ffmpeg.

**Next session:** Portfolio's v0.1 engineering quality bar is now essentially complete; remaining open issues across all 12 repos are the per-repo binary-recording follow-ups. The next autonomous session should either (a) consolidate the seven binary follow-ups into a single recording sweep, (b) start v0.2-style improvements driven by trending intake, or (c) survey the repos for under-documented decisions and write up the missing `core_decisions_human.md` entries.

## 2026-05-22 — docs/architecture.md claimed Playwright + flake-reduction were out of scope; both shipped weeks ago (#18)

**Duration:** ~30 min. **Issue:** [#18](https://github.com/jt-mchorse/ai-app-integration-tests/issues/18). **PR:** [#19](https://github.com/jt-mchorse/ai-app-integration-tests/pull/19).

The architecture doc was committed at the substrate-only PR and never reframed when Playwright tests (#2 CLOSED) and the `src/support/` flake-reduction helpers shipped. Four drift sites: directory diagram listed `src/` as 5 files and `test/` as 3 (reality: 6 and 8); the Example-app section said "Playwright is #2's scope, this PR ships the substrate" (Playwright shipped); "What this layer is NOT" listed Playwright and flake-reduction as out-of-scope (both shipped); an `# 14 tests` count-comment rot trap.

Rewrote the directory diagram to enumerate `src/support/`, all 8 test files, `example-app/e2e/`, and `scripts/`. Replaced the "Playwright is #2's scope" paragraph with the actual shipped split. Replaced "What this layer is NOT" with the genuinely-not bullets (not a hosted recording service; not a generic HTTP recorder) — both still accurate scope boundaries. Replaced `# 14 tests` with count-free phrasing.

Lock-against-drift: `test/architecture-doc.test.ts` (vitest, parallel to existing `readme-snapshot.test.ts`). Five invariants — path tokens resolve, four banned phrases absent, banned phrases hard-pinned, doc references at least one `src/support/` path, doc references at least one `example-app/e2e/` path. Tamper-verified.

Third architecture-doc-freeze fix this session, after `mcp-server-cookbook` #22 and `nextjs-streaming-ai-patterns` #18; all three same shape (arch doc commits at first PR and is never reframed when subsequent scope lands). Fifth drift fix of the session; thirteenth in the portfolio pattern. Open questions / blockers: none.


## 2026-05-23 — Architecture-doc lock gains active-decision-range + shipped-issue axes; backfills four D-NNNs and three issue refs (#20)

**Duration:** ~35 min. **Issue:** [#20](https://github.com/jt-mchorse/ai-app-integration-tests/issues/20). **PR:** TBD (this session).

`ai-app-integration-tests` is the **last of twelve repos** to gain the active-decision-range upper-bound axis on its architecture-doc lock — the pattern shipped first in `llm-eval-harness` (#32 just merged) and rolled out across the portfolio over the past two sessions. With this PR landed, all twelve portfolio repos carry the full upper-bound axis.

Two new invariants on `test/architecture-doc.test.ts`:

1. **Active-decision coverage.** Every non-superseded `D-NNN >= MIN_ACTIVE_DECISION_ID (= 2)` in `MEMORY/core_decisions_ai.md` must be cited at least once in `docs/architecture.md`. Regex parser (no YAML dep). `D-7`/`D-07`/`D-007` normalize to id 7.

2. **Closed-feature-issue coverage.** Every entry in `KNOWN_SHIPPED_ISSUES = [1, 2, 3, 4, 5]` (the five core deliverables per handoff §2: deterministic Anthropic replay, Playwright streaming tests, flake reduction, example-app, CI under 5 min) must be referenced. A sixth deliverable would require bumping the array; the hard-pin makes that unmissable.

Both `MIN_ACTIVE_DECISION_ID` and `KNOWN_SHIPPED_ISSUES` got their own hard-pin `it()` blocks so a loose edit can't widen the floor silently.

**Real drift caught on first run.** Four `D-NNN`s and three `#NN`s were missing from the doc:

- **D-007** (Next 15 App Router not Pages) — was implicit in the "Next.js 15 (app router, React 19)" prose; added `**D-007**` parenthetical.
- **D-008** (Playwright Anthropic stub via Next instrumentation hook, not the cassette layer) — the Playwright paragraph never explained *how* the deterministic stream gets into the browser context; backfilled the rationale.
- **D-009** (caller-supplied `classify` callback for flake classification) — the doc had `src/support/` paths in the directory diagram but no prose explaining the helpers; new "Flake-reduction helpers" section.
- **D-010** (CI caching, sub-five-minute goal) — the doc had no CI discussion at all; new "CI runtime" section.
- **#1** (deterministic Anthropic replay) — implicit throughout but never annotated; added to opening prose alongside D-002.
- **#3** (flake-reduction) — added in the new flake-helpers section.
- **#5** (CI under 5 min) — added in the new CI-runtime section.

Tamper-verified two ways: synthetic `D-099 superseded_by: null` appended to the decisions file → axis 4 fires naming `D-099`; `sed -i.bak 's/#1[^0-9]/_X/g'` stripping `#1` → axis 5 fires naming `#1`. A BSD-sed gotcha — `\b` word-boundary isn't supported — surfaced when the first attempt silently changed nothing; switched to the explicit `[^0-9]` look-behind shape.

Full vitest: 81/81 green (was 77 — gained 4 from the new axes). eslint clean. `tsc --noEmit` clean.

**Why this work, this session:** Second of two issues in this DAY session (first was `mcp-server-cookbook` PR #26, same axis pattern). Closes the last gap in the portfolio-wide active-decision-range upper-bound axis. With this and #26 merged, all twelve repos carry the full lock shape.

**Open questions / blockers:** None — PR ready for review.

**Next session:** The architecture-doc lock pattern is complete across the portfolio. Next sessions can pivot to other hygiene gaps, or wait for JT to direct (the only remaining open issues across all twelve repos are the seven priority:low operator-supplied 60-second demo GIFs — outside Cowork's reach).

## 2026-05-24 — Issue #22: `withRetryBudget` validates `backoffMultiplier`; `x-goog-api-key` joins the redaction allowlist

**Duration:** ~10 min. **Issue:** [#22](https://github.com/jt-mchorse/ai-app-integration-tests/issues/22). **Branch:** `session/2026-05-24-1548-issue-22`.

Two small parity / defensive gaps in the test-support modules. `withRetryBudget` was validating `maxAttempts >= 1` and `backoffMs >= 0` at function entry but not `backoffMultiplier` — a caller passing `0` zeroed-out exponential backoff after the first attempt, and a negative or non-finite multiplier produced alternating-sign / NaN backoffs via `Math.pow` that then poisoned the `sleep()` call. The undefined-default path (→ 2.0) is unchanged; only user-supplied values are validated, so callers that don't pass the field see no behavior change.

Separately, `SENSITIVE_HEADER_NAMES` was missing `x-goog-api-key` — the canonical header for Google Gemini / Vertex AI and Anthropic-via-Vertex SDK flows. A cassette recorded against a Google API today would have committed the key value. The redaction set now covers the four major AI provider header conventions: Anthropic native, OpenAI, AWS Bedrock (`x-amz-security-token`), and Google.

Three new tests: two on the multiplier guard (zero/negative reject; sub-1.0 valid because the guard is `> 0` not `>= 1.0`, so deliberate decay is supported); one on the redactor (mixed-case `X-Goog-Api-Key` redacts via the existing case-insensitive lower-key contract).

**Why this work, this session:** Eighth Phase B+C target of a 180-min day session — second TS frontend target after `nextjs-streaming-ai-patterns` #23. Same pattern as the day's earlier work: a previously-shipped capability didn't extend a small inch further than it should have. The session as a whole has been a sweep of these inch-gaps across the portfolio.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Wrap. Remaining repos for the loop (if continuing): `rag-production-kit`, `chunking-strategies-lab`, `vector-search-at-scale`, `llm-cost-optimizer` — all touched in Phase A this morning so the natural-rotation candidates are spent for now.

## 2026-05-25 — Issue #24: support/ range validators extended to finiteness
**Duration:** ~30 min · **Branch:** `session/2026-05-24-issue-24`

- Three existing range validators in `src/support/` checked sign-direction only. NaN and ±Infinity slipped past every guard, silently degrading test guarantees. The worst case was `expectSemanticallySimilar` with `threshold = NaN` — the check `threshold < 0 || threshold > 1` fails both arms (NaN comparisons are always false), so threshold passes, then `similarity < NaN` is also false, so the assertion *always passes regardless of input* — silently vacuous. A test author passing a NaN (from a config-derived value, a bad division, an empty env var) ends up with an assertion that looks fine until a real regression slips through review.
- `waitFor` with `timeoutMs = NaN` made the polling loop never time out; `+Infinity` hung `setTimeout` until CI's outer timeout. `withRetryBudget` with `maxAttempts = NaN` made the for-loop never execute and threw `RetryBudgetExhaustedError(NaN, undefined)`; with NaN backoffs poisoned `Math.pow` into NaN, then `setTimeout(NaN)` coerced to 0 and silently abandoned the schedule. Also `maxAttempts = 2.5` was accepted and silently rounded by the integer attempt counter.
- Tightened each callsite to require `Number.isFinite` (plus `Number.isInteger` for `maxAttempts`). Error messages updated from "must be >= 0" / "in [0, 1]" to "must be a finite number ..." so callers can grep the new contract. Public surface unchanged for valid inputs — every prior accepted value remains accepted.
- 19 new tests in `test/support.test.ts` under an issue-`#24` block: `test.each` over per-field bad-value tables (NaN, +Infinity, -Infinity, fractional for `maxAttempts`); boundary acceptance regressions per validator. Full suite 103/103 (was 84). Typecheck + ESLint clean.

**Why this work, this session:** Fifth (and final unvisited-tonight) Phase B+C target in the 360-min night session. All five repos that hadn't received attention earlier today now have a contract-tightening PR. Follow-up to #22 which added the sign-only validation; extending to finiteness is the natural next move and lines up with eleven sister PRs across the portfolio.

**Open questions / blockers:** none — PR ready for review.

**Next session:** All five originally-unvisited-tonight repos closed; the loop can now deepen on already-touched repos (each picked up one issue tonight) for more contract-tightening or pivot to a different harm class. Many candidates remain — cassette layer numerics, fetch-recorder limits, eslint rule add for "no sign-only finite checks."

## 2026-05-26 — Issue #26: installRecorder/installReplayer hosts validation closes the install-layer silent-degradation gap
**Duration:** ~25 min · **Branch:** `session/2026-05-26-0020-issue-26`

- `installRecorder({ hosts: [] })` and `installReplayer({ hosts: [] })` previously silently degraded to pass-through. `?? DEFAULT_HOSTS` short-circuits only on `undefined`, not on empty arrays. The resulting `new Set([])` had no entries; `shouldIntercept` returned `false` for every URL; **every fetch fell through to the real upstream**. Tests pass green while actually hitting live APIs in CI. Same harm class as D-005 (missing-cassette-is-fatal) but at the install layer above.
- Added a `validateHosts(hosts, fnName)` helper to `src/install.ts`. Skips when `hosts === undefined` (default path preserved). Throws with the function name on `length === 0`; throws with the function name + element index on any element that isn't a non-empty string. Element validation closes the TypeScript-escape cases — `[null]`, `[42]`, `["api.x.com", ""]` etc.
- `installRecorder` and `installReplayer` call `validateHosts` as their **first** statement, before the `originalFetch` capture. The ordering matters: rejection must not leave `globalThis.fetch` in a broken state. An explicit ordering pin in tests asserts `globalThis.fetch` is unchanged after a rejected install.
- New `test/install.test.ts` (23 tests): symmetric reject/accept matrices for both install functions (covering `[]`, `[""]`, `["...", ""]`, `[null]`, `[42]`, `[true]`, `[undefined]`; acceptance over 1-3 valid hosts; undefined-default preservation; explicit-undefined preservation), plus the ordering pin block. Full suite 103 → 126. Typecheck clean.

**Why this work, this session:** Ninth Phase B+C target in the 360-min night session. Different harm class than the #24 finiteness sweep on this repo — closes an install-layer silent-degradation path. Picked via build-sequence #12 (the last repo); completes the validation-sweep loop — every portfolio repo now has either a Phase A merge (4) or a Phase B+C PR (8) tonight.

**Open questions / blockers:** none — PR ready for review.

**Next session:** The validation-sweep arc has comprehensively touched all 12 repos this night session. Next-session candidates: a portfolio-ops MEMORY update reflecting this session's scope, or a pivot away from validation (the prior session memory called this out as the next direction).

## 2026-05-26 — Issue #28: Atomic CassetteStore.write closes the cassette-corruption blind spot
**Duration:** ~20 min · **Branch:** `session/2026-05-26-1537-issue-28`

- `CassetteStore.write` (src/io.ts:18) used `fs.promises.writeFile` directly. A SIGINT/OOM/disk-full mid-record leaves the cassette JSON zero-length or partial. The harm class extends D-005 (`missing-cassette-is-fatal`): the existing replay guard catches filename-vs-contents mismatches, but a partial-write where the truncation lands *after* `schema_version` and `request_hash` were already written will parse, return a partial object with missing message bodies, and **silently serve garbage** at replay time. That mode escapes the existing integrity check.
- Added a private `atomicWriteFile(target, data)` helper at the bottom of `src/io.ts` — same shape as `mcp-server-cookbook/servers/filesystem-sandbox/src/atomic_write.ts` (#36) and the four Python helpers landed earlier this session. Private placement keeps the public surface tight.
- Routed `CassetteStore.write` through it. Dropped the now-redundant `fs.mkdir(opts.dir, ...)` — the helper handles parent dir creation.
- 6 new tests in `test/atomic_cassette_write.test.ts`. The load-bearing one is `rename failure during overwrite preserves the pre-existing cassette bitwise`: write a cassette, capture bytes, simulate `fs.rename` failure on a re-record, assert (a) on-disk content is bitwise identical via `Buffer.equals` and (b) `store.read` returns the ORIGINAL response body (not the MUTATED). Two independent checks proving the same property — corrupting an old cassette during a re-record (the natural operator Ctrl+C path) cannot lose test coverage silently. Full vitest suite 126 → 132 passing. Typecheck clean. ESLint clean.

**Why this work, this session:** Sixth Phase B+C target in today's 180-min DAY session, second TypeScript implementation in the atomicity arc. Cassettes are the test repo's analogue of the cost-bench artifacts / eval JSONs / snapshot YAMLs that the four Python PRs closed earlier — same harm class, same fix shape.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Atomicity arc now spans six repos (four Python, two TypeScript). Two TypeScript repos with plausible candidates remain — `agent-orchestration-platform` (trace artifacts to disk if any) and `nextjs-streaming-ai-patterns` (probably no writes, SSR-only). Worth a quick survey to determine if they're actually candidates before committing to a 7th PR. Otherwise pivot to a different harm class.

## 2026-05-26 — Issue #30: README decision-range upper-bound lock (final)
**Duration:** ~6 min · **Branch:** `session/2026-05-26-2341-issue-30`

- Added `test/readme-decision-range.test.ts`.
- Added `D-002…D-011` citation under `## Architecture`.

**Why this work, this session:** Completes the portfolio at 12 of 12 repos — the drift class that surfaced in python-async-llm-pipelines PR #39 (D-011 landed without README range bump) can no longer recur silently anywhere.

**Open questions / blockers:** none.
**Next session:** Portfolio invariants saturated again; pivot.

## 2026-05-27 — Issue #32: CONTRIBUTING.md cadence-wording propagation
**Duration:** ~3 min · **PR:** #33

- Replaced pre-D-008 `~60-minute session cap` line with D-008 (180/360 min, multi-issue loop) and D-004 (Phase A PR auto-merge) wording, matching the bootstrap template post-portfolio-ops#3.

**Why this work, this session:** Iteration in the autonomous NIGHT session propagation arc for portfolio-ops#3.

**Open questions / blockers:** none.

**Next session:** continue portfolio propagation.

## 2026-06-02 — Issue #34: validateRecorderOptions + validateReplayerOptions (factory-layer parity)
**Duration:** ~22 min · **Branch:** `session/2026-06-02-0342-issue-34`

- Added `validateRecorderOptions(opts)` and `validateReplayerOptions(opts)` in `src/fetch-recorder.ts`, invoked at the top of `createRecorderFetch` / `createReplayerFetch`. Mirrors the installer-layer `validateHosts` shipped in #26 — extends the silent-pass-through harm-class closure one layer down to the factories that direct callers (custom embed, alternative install paths) reach. The harm class: `createRecorderFetch({ store, hosts: new Set() })` silently makes every fetch pass through to upstream because `shouldIntercept` returns false on an empty Set — **no cassettes are ever written, tests pass green while actually hitting live APIs**. Worst shape for the repo's purpose. The error message names the harm directly so operators reading the throw understand the *why*.
- Store check is duck-typed (`isStoreLike` checks `read` + `write` are functions) so the factory doesn't have to import `CassetteStore` for an `instanceof` — keeps the factory's concrete-class footprint at zero and lets test fakes satisfy the contract without subclassing.
- Layered defense: the installer-layer #26 gate fires first on the `installRecorder({ hosts: [] })` path with its own message; the factory-layer #34 gate is the backstop. Tests explicitly assert the installer-layer error message is still seen on the installer path, so the two layers don't collide on the same call site.
- 20 new vitest cases in `test/fetch-recorder-validation.test.ts`: 4 store checks (recorder), 6 hosts checks (recorder), 3 replayer reuses (covers the same per-field surface as a sanity check that the second factory has identical posture), 2 construction-time gates (recorder + replayer), 3 installer round-trip acceptance regressions. Full suite 153/153 pass (was 133).
- `docs/architecture.md` "fetch-recorder" paragraph gains a bullet citing #34 and #26 alongside. `KNOWN_SHIPPED_ISSUES` arch-doc pin unchanged at (1,2,3,4,5) because #34 is a parity propagation, not a new core deliverable. No new `D-NNN` — pure extension of the established posture to the layer below.

**Why this work, this session:** Iteration 4 of the night session loop. `ai-app-integration-tests` was the last untouched-since-2026-05-27 candidate (position 12 in build sequence). The #26 silent-pass-through closure is one of the load-bearing safety invariants in this repo — its factory-layer counterpart was the only direct-caller surface that could still produce the harm. Closing it saturates the protection.

**Open questions / blockers:** none — ready for review.

**Next session:** All four untouched-since-2026-05-27 repos (vector-search-at-scale, mcp-server-cookbook, nextjs-streaming-ai-patterns, ai-app-integration-tests) closed this run. Future iterations: pivot back to the recently-touched repos for any next-tier parity opportunities, or pick from the existing low-priority demo-capture issues if operator unblocks them.

## 2026-06-17 — Issue #36: Workflow YAML-parseability lock
**Duration:** ~6 min · **Branch:** `session/2026-06-17-1934-issue-36`

Added `test/workflows-yaml-parseable.test.ts` (vitest, 3 tests for
`ci.yml`) and pulled `js-yaml` + `@types/js-yaml` into
`devDependencies`. Mirrors `agent-orchestration-platform#42` and
`nextjs-streaming-ai-patterns#34`.

**Why this work, this session:** Twelfth and final hop of the
`portfolio-ops#30` propagation arc — every portfolio repo now carries
the lock.

**Open questions / blockers:** none — PR #37 open.

**Next session:** with the propagation arc complete, future sessions
return to per-repo feature work. The lock test grows naturally as new
workflow files are added.

## 2026-06-18 — Issue #38: timeout-minutes guard + lock test
**Duration:** ~15 min · **Branch:** `session/2026-06-18-0339-issue-38`

- Added `timeout-minutes` to every job in `ci.yml`: `toolkit` 15, `example-app` 20, `playwright` 25, `no-leaked-secrets` 15, `memory-check` 15. `playwright` is the heaviest (Chromium install + production Next.js build + multi-test e2e).
- Added `test/workflows-timeout-minutes.test.ts` — 16 new tests (1 smoke + 5 jobs × 3 invariants).

**Why this work, this session:** tenth hop in the portfolio-wide timeout-minutes propagation arc; fourth Vitest hop. After this lands, only `portfolio-ops` itself remains.

**Open questions / blockers:** none.

**Next session:** the last hop — propagate the lock to `portfolio-ops` itself.

## 2026-06-18 — Issue #40: workflows-concurrency lock (final hop, 13/13)
**Duration:** ~15 min · **Branch:** session/2026-06-18-1917-issue-40

- Added `test/workflows-concurrency.test.ts` mirroring the canonical
  TS shape from `nextjs-streaming-ai-patterns`: vitest + js-yaml,
  parametrized over `.github/workflows/*.yml`, three per-file
  invariants (block exists, `group` is non-empty string,
  `cancel-in-progress` is the YAML bool `true`), plus a smoke-discovery
  boundary that fails loudly on an empty fixture set.
- vitest run: 172 → 176 tests, no regressions.

**Why this work, this session:** This repo's `ci.yml` already had the
concurrency block from an earlier session, so the runtime behavior was
correct, but the lock test that would catch removal in a future PR
was the only gap in the 13/13 portfolio-wide concurrency-lock arc.
Surfaced during the 2026-06-18 day session's Phase A review pass when
the 12 propagation PRs from `llm-eval-harness#64` landed across the
other 12 repos.

**Open questions / blockers:** none. Test count 172 → 176.

**Next session:** the portfolio-wide PR-time silent-rot prevention arc
is now at 13/13 for all three invariants (yaml-parseable, timeout-
minutes, concurrency). Future work should pivot away from lock
propagation onto either real product features in priority-tier repos
or a new fingerprint shape if one is identified.

## 2026-06-22 — Issue #42: normalizeUrl — canonicalize repeated same-key query params
**Duration:** ~25 min · **Branch:** `session/2026-06-22-1931-issue-42`

- Found via a Phase A Explore-subagent sweep over the toolkit (cassette/fetch-recorder/io/install/retry-budget/semantic-assert/wait-for) — the only open issue (#16) is a `priority:low` demo-capture binary not doable headless, so the dogfood pattern surfaced real work instead. `normalizeUrl` sorted query params by key only; since JS sort is stable, repeated same-key params (`?tag=a&tag=b`) kept their input order, so that and `?tag=b&tag=a` normalized and hashed differently — a replay miss that throws `MissingCassetteError` under D-005 (no silent fallback), violating the canonicalization contract on `NormalizedRequest.url`.
- Fix: break the key-sort tie by value, consistent with the existing by-key sort and `canonicalize`'s recursive body-key sort. The existing "preserves repeated query params" test only checked value *presence*, not order — so the gap was unguarded. Tightened it to assert canonical order and added `normalizeUrl` order-equivalence + `hashRequest` hash-equality tests across the two orderings. Both fail pre-fix. Suite 176 → 178, tsc + eslint clean. PR #43 ready.

**Why this work, this session:** the repo's only open issue is a headless-impossible demo capture; a dogfood sweep found a real replay-correctness bug in the cassette matching contract — strictly higher value than no work.

**Open questions / blockers:** none.

**Next session:** the URL canonicalization is now order-complete for both cross-key and same-key params. No further `normalizeUrl` lead; broader URL canonicalization (trailing-slash, default-port, percent-encoding case) is not a known failure mode and was deliberately deferred.

## 2026-06-22 — Issue #44: fetch-recorder — captureSse never flushed the streaming TextDecoder
**Duration:** ~15 min · **Branch:** `session/2026-06-22-2343-issue-44`

- Found via a Phase A dogfood Explore agent over the cassette layer, then verified with a Node TextDecoder repro. `captureSse` decoded the SSE body with `decoder.decode(value, { stream: true })` in the read loop but never called the final `decoder.decode()` flush. With `stream: true`, an incomplete trailing multibyte UTF-8 sequence stays buffered inside the decoder; without the flush it was silently dropped from the recorded body when a stream ended mid-character (a truncated/aborted recording). Cross-chunk multibyte splits were already handled; only the end-of-stream case lost bytes.
- Fix: add the standard final `buf += decoder.decode()` flush after the loop so buffered bytes surface as U+FFFD instead of vanishing. Regression test ends an SSE stream on an incomplete multibyte chunk and asserts the recorded + replayed body preserve the replacement char; it fails pre-fix. Suite 178 → 179, tsc + eslint clean. PR #45 ready.

**Why this work, this session:** the portfolio is saturated; a dogfood sweep of the cassette recorder surfaced a real silent-data-loss gap (the textbook streaming-decoder flush omission). Low reachability (only a truncated stream ends mid-character) so filed priority:low, but a genuine correctness fix with a clean standard-pattern resolution.

**Open questions / blockers:** none.

**Next session:** no further `fetch-recorder` lead; the decoder is now flushed at end-of-stream. URL canonicalization (from #42) and the demo-capture binary (#16) remain the only open items.

## 2026-06-23 — Issue #46: secret scanner missed Google (AIza…) API keys
**Duration:** ~15 min · **Branch:** `session/2026-06-23-0401-issue-46`

- Closed a consistency gap in `assertNoLeakedSecrets`. It scans the whole serialized cassette but only knew the `sk-`/`sk-ant-`/`Bearer` shapes. Issue #22 had already brought Google keys into the redaction scope (`x-goog-api-key`), yet a Gemini/Vertex key (`AIza…`) leaking through a non-redacted channel — e.g. a 400 error body echoing the submitted key — passed the scanner and would be committed into a cassette.
- Added the `AIza…` pattern (open-ended length, matching the `sk-…{32,}` style). Added a response-body leak test mirroring the existing `sk-ant` one. Red pre-fix, green post-fix. Suite 179 → 180, tsc + eslint clean.

**Why this work, this session:** found by a different-angle second pass in the night session's Phase A dogfood wave (first pass on this repo was clean). A real silent secret-leak-into-VCS gap on a security-critical guard.

**Open questions / blockers:** none.

**Next session:** trailing-dot FQDN gap in `shouldIntercept` is too low-reachability (no SDK emits trailing dots, fails loudly in replay) to file.

## 2026-06-23 — Issue #48: fetch-recorder host matching was case-sensitive
**Duration:** ~20 min · **Branch:** `session/2026-06-23-1950-issue-48`

- A Phase A dogfood sweep of the fetch-recorder path found that `shouldIntercept` compared the always-lower-cased `URL.hostname` against a hosts Set taken verbatim from the caller. A mixed-/upper-case host entry never matched, so the recorder silently degraded to pass-through (tests green, live API hit, no cassette) — the same harm class the existing `validateHosts` guards prevent.
- Added a `normalizeHosts` helper and lower-cased the host set once in each factory (`createRecorderFetch`/`createReplayerFetch`), covering both the install helpers and direct callers. Added recorder + replayer tests with mixed-case hosts. Suite 180 → 182, eslint + tsc clean.

**Why this work, this session:** sixth dogfood find of the DAY session, on a TypeScript repo whose surface the night-session Python waves hadn't deeply probed.

**Open questions / blockers:** none.

**Next session:** none specific to this issue.

---
## 2026-06-25 — Issue #50: query-param sort used localeCompare → non-reproducible cassette hash
**Duration:** ~25 min · **Branch:** `session/2026-06-25-1525-issue-50`

- `normalizeUrl` (in `src/cassette.ts`) sorted query parameters with `String.prototype.localeCompare`, whose ordering depends on the runtime's default ICU locale. The request hash (`hashRequest` over `{method,url,body}`) was therefore not stable across environments — a cassette recorded under one locale could normalize the same URL to a different param order under another, hash differently, and fail replay with `MissingCassetteError`. It also diverged from `canonicalize`, which sorts body keys with the default code-unit `.sort()`.
- Replaced `localeCompare` with a locale-independent `compareCodeUnits` helper for both the key sort and the same-key value tie-break, matching `canonicalize`'s ordering. Existing `normalizeUrl` tests used only lowercase ASCII keys (where the two orderings agree), so the bug was invisible — added two mixed-case regression tests (exact code-unit output; param order equals `canonicalize` body-key order). Red-without / green-with on this en-US runtime; suite 182 → 184, eslint + tsc clean.

**Why this work, this session:** ai-app-integration-tests was the earliest repo in build sequence among those >36h stale (priority tier all <18h fresh after this run's earlier work; mcp-server-cookbook #54/#55 human-blocked decision-revisit, skipped per D-007; this repo's only open issue #16 is a human-blocked demo-binary capture). The recorder's determinism is the repo's core promise, and this was a real cross-locale hash-stability gap in it.

**Open questions / blockers:** none.

**Next session:** URL fragment / default-port / non-JSON-body (`URLSearchParams`) normalization are separate, lower-value matching edge cases if the recorder's matching surface is revisited.

## 2026-06-27 — Issue #54: proxy-authorization / api-key credentials leak into cassettes
**Duration:** ~20 min · **Branch:** `session/2026-06-27-0026-issue-54`

- `SENSITIVE_HEADER_NAMES` redacted `authorization` but not `proxy-authorization` (RFC 7235 proxy creds, typically a prefix-less `Basic …` value) or the bare `api-key` header (Azure OpenAI's prefix-less 32-hex key). `redactHeaders` redacts by exact name and the `assertNoLeakedSecrets` scanner only matches prefixed shapes (sk-/Bearer/AIza), so a Basic proxy credential or an Azure key passed through **both** layers and was written verbatim to a committed cassette — defeating D-004 (committed cassettes never carry credentials). Reproduced through both layers.
- Fixed by adding `proxy-authorization` and `api-key` to `SENSITIVE_HEADER_NAMES`, plus a prefix-less `Basic` pattern to `API_KEY_PATTERNS` so a Basic credential leaking through any un-redacted channel (e.g. an echoed proxy-407 error body) still trips the scanner. 3 regression tests; suite 186 → 189, typecheck + eslint clean.

**Why this work, this session:** eighth issue of a multi-issue DAY run. The three preceding non-tier dogfoods (embedding-model-shootout, python-async-llm-pipelines, agent-orchestration-platform) all came back clean — healthy, mature repos with no fabricated work — so this real, security-relevant finding in ai-app-integration-tests was the payoff of the final pass.

**Open questions / blockers:** none. Saturation signal — 3 of 4 non-tier repos dogfooded this run were clean; the non-tier set is mature and marginal bug yield is dropping.

**Next session:** mcp-server-cookbook #54/#55 remain JT-decision-blocked (D-007); broader prefix-less-key scanning (generic 32+ hex) was deliberately deferred here for false-positive risk.

## 2026-06-27 — Issue #56: normalizeUrl leaks the URL fragment into the request key
**Duration:** ~20 min · **Branch:** `session/2026-06-27-0352-issue-56`

- `normalizeUrl` canonicalized query-param order but left the URL fragment (`#...`) in the returned string, which feeds `hashRequest`. The fragment is never sent to the server (RFC 3986 §3.5 / WHATWG fetch), so two requests differing only by fragment are wire-identical yet hashed differently — a cassette recorded with a fragment misses on replay (`MissingCassetteError`, D-005 throws). Same canonicalization class as the query-param ordering fix (#42/#51), one field over.
- Fixed by adding `u.hash = ""` next to the existing `u.search = ""` (one line). Added a normalizeUrl unit test and a record-with-fragment / replay-without round-trip test. npm test 189 → 191, tsc + eslint clean. Filed the secondary `__raw_body__` sentinel-collision finding as low-priority #57 (file-and-defer).

**Why this work, this session:** eighth issue of a multi-issue NIGHT run; a clean one-line request-keying fix surfaced by a parallel dogfood agent.

**Open questions / blockers:** none.

**Next session:** request normalization now ignores the fragment; the `__raw_body__` sentinel collision (#57) remains open as low-priority.

## 2026-06-27 — Issue #57: raw-body vs JSON-body cassette hash collision
**Duration:** ~25 min · **Branch:** `session/2026-06-27-2312-issue-57`

- A non-JSON request body was wrapped as `{"__raw_body__": <text>}` before canonicalization, so a raw `foo` hashed the same as a real JSON `{"__raw_body__":"foo"}` — the second recording overwrote the first and replay served the wrong response.
- Fixed by storing raw bodies as plain text and adding a `bodyEncoding: "json" | "raw"` discriminator on `NormalizedRequest`, a sibling field no caller JSON can forge. `hashRequest` folds it in only for raw bodies, so existing JSON/no-body cassette hashes are unchanged (no re-record needed).
- Added 3 tests (hash split + hash stability + record→replay two-cassette round trip). Suite 191 → 194, typecheck + lint clean.

**Why this work, this session:** It was the only pre-triaged, autonomously-fixable bug — all `priority:high` issues across the portfolio are `decision-revisit` items needing JT input, and the demo issues need video capture.

**Open questions / blockers:** none for this issue. The literal-`null`-body edge is deferred (pre-existing, more contrived).

**Next session:** Portfolio is saturated for autonomous high-priority work; continue dogfood→file→fix on priority-tier repos.

## 2026-06-28 — Issue #60: secret scanner missed credentials ending in a non-word char
**Duration:** ~20 min · **Branch:** `session/2026-06-28-0356-issue-60`

- Every `API_KEY_PATTERNS` regex ended in `\b`, but the charclasses can end in non-word chars (`=` base64 padding, `+`/`/`/`-`/`.`). `\b` can't anchor between two non-word chars, so a credential ending in such a char — when short enough that the trailing char is needed to hit `{N,}` — slipped the scanner and leaked into a committed cassette. Reproduced with `Basic YWJjOmRlZmdoaWo=` (base64 of `abc:defghij`): `assertNoLeakedSecrets` did not throw.
- Fixed by removing the trailing `\b` from all five patterns; leading `\b<prefix>` + `{N,}` still bound the match start/length, and dropping the trailing anchor only widens coverage — the safe direction for the D-004 leak guard. +3 tests; full toolkit (197) green, lint + typecheck clean.
- Found via the third Phase A dogfood wave (security-relevant; HIGH).

**Why this work, this session:** a HIGH-severity credential-leak gap in the belt-and-suspenders guard whose whole job is to keep secrets out of git.

**Open questions / blockers:** none.

**Next session:** —

## 2026-06-28 — Issue #62: read() crashed with a TypeError on a null-content cassette
**Duration:** ~20 min · **Branch:** `session/2026-06-28-1628-issue-62`

- `CassetteStore.read` cast `JSON.parse(raw)` to `CassetteV1` and dereferenced `.schema_version` with no null/object guard. A cassette file whose top-level JSON is `null` (a plausible partial-write/hand-edit artifact) made `JSON.parse` return `null`, so `null.schema_version` threw `TypeError: Cannot read properties of null` — the exact cryptic crash the integrity guards exist to replace. Array/string/number top-levels already got a (misleading) `schema_version undefined` error; only `null` crashed. And since `read` returns `CassetteV1 | null` where `null` means ENOENT ("no cassette"), a corrupt `null` file must fail loudly, not be mistaken for missing.
- Fixed by guarding the parse result before the integrity checks: `null` / non-object / array now throw a clean `Error` naming the actual kind, which also upgrades the array/string/number cases to the accurate "did not parse to a cassette object" message. Added a parametrized regression test (null/array/string/number → clean Error, not TypeError) plus a happy-path round-trip; the 4 cases were proven to fail pre-fix. Full toolkit 202 passed, typecheck + lint clean.

**Why this work, this session:** seventh substantive issue of a multi-issue DAY run and the final repo dogfooded — completing a sweep of all 13 portfolio repos this session (5 of which yielded a real bug; the rest were verified clean or appropriately deferred). A genuine robustness defect: the load-bearing replay loader crashed cryptically on corruption it was meant to surface cleanly.

**Open questions / blockers:** none.

**Next session:** continue the loop if time remains.

## 2026-06-28 — Issue #64: URL userinfo credentials leaked into cassettes in cleartext
**Duration:** ~22 min · **Branch:** `session/2026-06-28-2344-issue-64`

- `normalizeUrl` stripped the fragment but left URL **userinfo** (`user:pass@host`) intact, so a credentialed request URL was written to the cassette in cleartext and committed to git. The same Basic credential sent as an `Authorization`/`proxy-authorization` header is redacted — but as URL userinfo it slipped both layers (no `API_KEY_PATTERN` matched a `user:pass@` shape), so `assertNoLeakedSecrets` never threw. A direct violation of D-004's two-layer no-leaked-credential guarantee.
- Fixed primarily by stripping `username`/`password` in `normalizeUrl` (fail closed, mirroring the fragment strip; userinfo is non-wire-distinguishing so replay parity is preserved). Added a tightly-anchored `scheme://user:pass@` pattern to `assertNoLeakedSecrets` as the belt-and-suspenders second layer, anchored on `//` to avoid false-positives on JSON emails/timestamps. 3 tests (strip + replay parity; scanner catch; no false positive). Toolkit 202 → 205, typecheck + lint clean.

**Why this work, this session:** fourth issue of a multi-issue DAY run. With priority-tier autonomous work exhausted, a third non-tier dogfood round found prompt-regression-suite clean and surfaced this credential-leak parity gap in ai-app-integration-tests.

**Open questions / blockers:** none.

**Next session:** continue the loop if time remains. Secondary low-confidence note (not filed): `hashRequest` collides a no-body request with one whose body is the literal JSON `null` — same class as #57, only reachable for the unusual literal-`null` body.

## 2026-06-29 — Issue #66: architecture.md said three redaction regexes, but six ship
**Duration:** ~9 min · **Branch:** `session/2026-06-29-0403-arch-redaction-regex-count`

- `docs/architecture.md` said the cassette body scan rejects on "three regexes" (sk-/sk-ant-/Bearer), but `API_KEY_PATTERNS` is six — AIza (#22), Basic (#54), and URL userinfo (#64) were added later without updating the doc. Enumerated all six. The matching phrasing in `core_decisions_human.md` is append-only decision history (the patterns extended D-004), left as-is.

**Why this work, this session:** eleventh issue of the night run, from the second parallel doc-contract subagent batch.

**Open questions / blockers:** none.

**Next session:** the documented redaction-regex count matches the shipped `API_KEY_PATTERNS`.

## 2026-06-29 — Issue #68: recorder/replayer crashed on null-body statuses (204/205/304)
**Duration:** ~25 min · **Branch:** `session/2026-06-29-2353-issue-68`

- Per the Fetch spec, a null-body status (204 No Content, 205 Reset Content, 304 Not Modified) forbids any response body — `new Response` throws a `TypeError` even for an empty-string body, only `null` is accepted. The recorder and replayer built `new Response(body, { status })` with `body === ""` for these statuses, so a valid 204 (e.g. a `DELETE`) crashed with a raw `TypeError` from inside `globalThis.fetch` instead of round-tripping. Every existing test used status 200, so the class was never exercised.
- Reproduced both the record and replay crashes firsthand end-to-end, then fixed with a `NULL_BODY_STATUSES` set + `bodyForStatus(status, body)` helper returning `null` for those statuses, applied at all four `new Response(...)` sites (non-streaming record, SSE record, non-streaming replay, SSE replay). 3 lock tests (record+replay for 204/205/304), all confirmed failing pre-fix. Suite 205 → 208, tsc + eslint clean.

**Why this work, this session:** fifth substantive issue of a multi-issue DAY run. Priority tier was exhausted, so rotated through non-tier repos; a dogfood hunter surfaced this spec-conformance crash, verified firsthand before acting.

**Open questions / blockers:** none.

**Next session:** continue the loop; this run's sweep found the portfolio otherwise deeply saturated (6 of 8 hunted repos clean).

## 2026-07-01 — Issue #70: JSON-null request body collided with a no-body request (wrong replay)
**Duration:** ~25 min · **Branch:** `session/2026-07-01-1928-issue-70`

- `hashRequest` folded the `bodyEncoding` tag into the request hash only for *raw* bodies. A `POST` whose body is the JSON literal `null` normalizes to `{ body: null, bodyEncoding: "json" }`, and a request with no body normalizes to `{ body: null }` with no tag — both canonicalize to `body:null`, so dropping the `"json"` tag made them hash identically. The recorder then overwrote one cassette with the other and the replayer served the wrong response. It's the exact #57 raw-vs-JSON collision class, one value over: every *other* JSON body is non-null so can't collide with no-body, but a literal `null` slips through. Reproduced firsthand end-to-end (only one cassette written; the null-body request replayed the no-body response).
- Fixed by widening the fold condition to also cover a present body that canonicalizes to `null` (`bodyEncoding !== undefined && body === null`). Only the buggy json-null hashes change; every non-null JSON-body, no-body, and raw hash stays byte-identical, so already-recorded cassettes still replay (the #57 backward-compat lock is preserved). +3 tests (hash-level, raw-hash-stable, end-to-end record+replay); suite 208 → 211, typecheck/build/eslint clean. Inverse safety net confirmed via `git stash`.

**Why this work, this session:** second issue of the DAY run. `ai-app-integration-tests` was the stalest repo overall (40h, over the 36h floor) with only a binary-asset demo issue open, so a dogfood hunt drove the work. Of two parallel hunters, the support/flake-reduction modules came back clean and the recording core surfaced this genuine collision.

**Open questions / blockers:** none — PR #71 ready for review.

**Next session:** empty-string body (`""`) is currently treated as no-body (a length-0 guard in `normalizeRequest`); whether an empty POST body should be wire-distinct from no body is a separate, more debatable semantic — left unfiled. Continue the loop.

## 2026-07-04 — Issue #72: architecture-doc symbol-resolution lock (TS side of portfolio-ops #55)
**Duration:** ~35 min · **Branch:** `session/2026-07-04-0326-issue-72` · **PR:** #73

- Added a symbol-resolution invariant to `test/architecture-doc.test.ts` — the last of portfolio-ops #55's three TS repos (siblings: nextjs #76, mcp-server-cookbook #82). The doc names its code surface concretely (`installFromEnv`, `redactHeaders`, `MissingCassetteError`, `createRecorderFetch`, `canonicalize`, …); nothing verified those symbols existed, so a rename would leave the doc stale with CI green. Since this doc is CamelCase-rich, it took the nextjs #76 resolver shape (not mcp #82's tool-name shape): multi-word camel/Pascal inline-code identifiers resolved against a static scan of all top-level declarations in `src/` (exported or internal), with hard-pinned `EXTERNAL_SYMBOLS` (`ReadableStream`, `globalThis`) and `DOC_ILLUSTRATIVE` (`rawBody` — a pseudo-code local in the hashing prose, verified absent from src). Inverse-drift test guards against vacuous green; negative-controlled by renaming a live symbol.
- All twelve current candidates classify (nine declarations, two external, one illustrative) — no live drift. Suite 213 → 220; tsc + eslint clean.

**Why this work, this session:** third and final issue of the NIGHT loop, completing #55's TS-side propagation. Worked in build-sequence order after nextjs #76 (#11) and mcp-server-cookbook (#10); ai-app-integration-tests is #12.

**Open questions / blockers:** none — ready for review. Noted a pre-existing untracked local file `test/bug_hunt.test.ts` (not on origin/main) with an unused-var lint error; left it alone (not mine), scoped the commit to only the test file so it's absent from the PR/CI.

**Next session:** portfolio-ops #55 can be closed once nextjs #77 / mcp #83 / ai-app #73 merge (Python side already done). Portfolio remains saturated; remaining open issues are JT-blocked decision-revisits and operator-visual demo captures.

## 2026-07-04 — Issue #74: example-app tool-name resolution (folded into PR #73)
**Duration:** ~20 min · **Branch:** `session/2026-07-04-0326-issue-72` · **PR:** #73 (also closes #72)

- The #72 CamelCase resolver excludes snake_case, so the doc's example-app tool claims (`/tools` — "Two tools (`get_weather`, `calculate`)") were still unlocked. Added an example-app tool-name invariant using the mcp-server-cookbook #82 approach: tool names from the doc's `N tools (…)` syntax resolved against `name: "…"` registrations scanned in `example-app/app/api/` (scan root hard-pinned). Both tools resolve; inverse-drift and a manual negative control (renamed `get_weather`) confirm the lock bites. Suite → 224 green; tsc + eslint clean.
- **Folded into PR #73 rather than a separate PR** because both touch `test/architecture-doc.test.ts` and #73 isn't merged yet — two concurrent same-file PRs against main would guarantee the documented sibling-append conflict. #73 was unreviewed, so broadening it to close both #72 and #74 is the clean one-file/one-theme outcome.

**Why this work, this session:** fourth iteration; closes the snake_case tool gap the #72 resolver left, keeping the whole architecture doc symbol-accurate.

**Open questions / blockers:** none. Deferred: error-kind (`validation`/`upstream`/`shape`) resolution — a union-type shape, separate concern.

---

## 2026-07-09 — Issue #75: canonicalize drops a __proto__ body key (wrong-cassette replay)
**Duration:** ~25 min · **Branch:** `session/2026-07-09-0402-issue-75` · **PR:** #76

- `canonicalize` rebuilt each object into a plain `{}` and assigned `out[k] = ...`. A body key literally named `__proto__` (a real own key after `JSON.parse`) hit the prototype setter, mutated `out`'s prototype, and was omitted by `JSON.stringify`. Two bodies (one with `__proto__`, one without) then canonicalized to identical bytes and hash-collided — the recorder overwrote one cassette with the other and replay served the wrong response.
- Fix: build the accumulator with `Object.create(null)` so `__proto__` is stored as an own property and folds into the hash. Every non-`__proto__` body is byte-identical (Object.keys/.sort()/JSON.stringify are unchanged on null-proto objects); the cassette round-trip stays safe. Regression tests for top-level + nested `__proto__` and distinct `hashRequest`.
- Reproduced firsthand on clean main; full suite 225 passed, eslint + tsc clean. Found by a parallel dogfood agent (request-hashing lens), verified firsthand.

**Why this work, this session:** Static queue globally exhausted; ai-app-integration-tests hadn't been worked in ~4 days. Upholds the cassette-hash invariant (#57/#70 lineage) — two different requests must not hash the same.

**Open questions / blockers:** none.

**Next session:** prototype-pollution-adjacent key handling — check other repos' canonicalizers / dedup maps / key-by-key object builders for the same dropped-`__proto__`/`constructor` special-key class.

## 2026-07-10 — Issue #77: validate the nested cassette response shape (~22 min, night)

**What got done.** `CassetteStore.read` (#62) guarded only the top-level container type — a top-level `null`/array/primitive is rejected cleanly — but returned the object without validating the nested `response`, and `rebuildResponse` then dereferenced `response.headers` (`Object.entries`), `response.kind`, and `response.frames` (`for...of`). A present-but-wrong-typed `response`/`headers`/`frames` (a partial-write or hand-edit artifact) passed every guard and threw a raw `TypeError` at replay — the exact failure mode #62 set out to eliminate, one seam over.

Added `assertValidResponse` in `io.ts` (called after the `request_hash` check): `response` must be a non-null object, `response.headers` a non-null object, and — by the `kind` discriminant — a `non_streaming` response has a string `body` while an `sse` response has an array `frames`; an unknown/absent `kind` is rejected. It fails with the same clean `refusing to use it` Error as the top-level guard, never a raw `TypeError`. Seven malformed-response `it.each` cases + a well-formed sse round-trip. Reproduced firsthand via `tsx` driving `createReplayerFetch` (discovering the request hash from `MissingCassetteError`), before and after.

**Gotcha.** The `fakeCassette` test helper omitted `kind` (casting `as CassetteV1`), but the real recorder always writes `kind` and a kind-less response can't replay (falls to the SSE branch, `frames` undefined → crash), so I corrected the fixture to carry `kind: "non_streaming"`. Also: `createReplayerFetch`'s `hosts` option must be a `Set`, not an array. Full suite green (233 passed); eslint + typecheck clean.

**Why prioritized.** Static priority:high queue globally exhausted; found via the sibling-incomplete-fix meta-lens (JSON-loader nested field-type guard, sibling of #62).

**Open questions / blockers.** None — PR ready for review.
## 2026-07-11 — Issue #79: validate response.status in cassette read() (~18 min, night)

**What got done.** `assertValidResponse` (#77/#78) guarded the nested recorded response's `headers`/`kind`/`body`/`frames` but skipped `status` — the one `RecordedResponse` field `rebuildResponse` *also* dereferences, feeding it to `new Response(..., { status })`, which throws a raw `RangeError` outside integer 200–599. So `read()` certified a cassette with an out-of-range / non-integer / non-number status as valid and the crash landed deep in `rebuildResponse` at replay, one seam over from the fields #77 did guard. `status` isn't caller-controlled at replay — it comes from the committed cassette file (hand-edit, partial write, merge artifact, unclamped upstream).

Added a `status` check to `assertValidResponse` (integer in 200–599, the constructor's accepted range) with the same "malformed response" message, so `read()` rejects cleanly. Tests: `read()` rejects status `0`/`999`/`100`/`200.5`/`"200"`/`null`/absent as a clean `Error` (not TypeError/RangeError); valid `200`/`204`/`599` still round-trip. Full suite (243), eslint, tsc green. Verified every link firsthand (assertValidResponse never read status; rebuildResponse feeds it to `new Response`; `new Response(null,{status:999})` throws RangeError).

**Why prioritized.** Static priority:high queue globally exhausted; found via the sibling-incomplete-fix meta-lens on the 8 PRs merged in this run's Phase A (sibling of #77/#78). Confirmed the nested `request` shape is NOT a gap (never dereferenced on the replay/matching path after `read()`), so no churn PR there.

**Open questions / blockers.** None — PR #80 ready for review.

## Session 2026-07-13 (night) — issue #82: validate cassette header entries at read()

`assertValidResponse` checked that a cassette's `response.headers` is an object, but never validated its entries. On replay, `rebuildResponse` feeds each entry to `Headers.set(k, v)`, which throws a raw `TypeError` for an invalid header name (a key with a space or empty string) or a non-string / control-character value (`\n`, `\x00`). So a hand-edited / partial-write / merge-artifact cassette passed `read()` validation and then crashed deep in `rebuildResponse`, one seam over — the same "raw error at replay" mode the #77 nested-shape guard and #80 status-field guard were written to prevent.

The fix iterates the header entries after the is-an-object check: it rejects any non-string value and probes each `(k, v)` against a throwaway `new Headers()` in a try/catch, `bad(...)`-ing anything `Headers.set` would reject. `read()` now fails with the clean "malformed response ... refusing to use it" Error. Reproduced firsthand against the built `dist/` (read() accepts a `{"content type": "x"}` cassette, replay throws) before fixing. Added five malformed-header rows to the #77 `it.each` plus a well-formed round-trip guard against over-blocking; full suite green (249 tests), lint + typecheck clean.

**Why this work, this session:** Sixth hit of the night run, surfaced by the sibling-incomplete-fix dogfood hunt on ai-app-integration-tests and verified firsthand.

**Open questions / blockers:** none — PR #83 ready for review.

**Next session:** Phase A merge PR for #82.

## 2026-07-13 (night) — Issue #84: empty-string body collides with no-body request
**Duration:** ~20 min · **Branch:** `session/2026-07-13-1139-issue-84` · **PR:** #85

`normalizeRequest` (`fetch-recorder.ts:43`) tagged a request body only when `bodyText !== null && bodyText.length > 0`. An explicit empty-string body (`fetch(url, { method: "POST", body: "" })`) failed the `length > 0` guard, so it was left untagged (`body:null`, no `bodyEncoding`) — byte-identical to a no-body request. The two hash-collided, so a never-recorded no-body request silently replayed the empty-body cassette (and vice-versa). This is the exact wrong-cassette-replay class that #57 (raw-vs-JSON) and #70/#71 (JSON-null-vs-no-body) exist to prevent; an empty-string body is a *present* body (a POST with Content-Length: 0), and #70's `bodyEncoding` fold couldn't fire because the empty body never reached the tagging block. Fixed by tagging an empty string as `raw` (it isn't valid JSON), keeping it distinct from no-body. Verified firsthand via the public recorder/replayer API: pre-fix the no-body replay served the empty-body cassette; post-fix it correctly misses, and no-body/JSON-body hashes are unchanged so existing cassettes still replay. One end-to-end lock test; full suite (250) green, typecheck + lint clean.

**Why this work, this session:** Fourth hit of the night run — the only non-empty result of a diverse-lens wave (lco aliasing, rag collision, leh aliasing/parity, aop all EMPTY) — surfaced by the ai-app sibling-incomplete-fix hunt and verified firsthand end-to-end before filing.

**Open questions / blockers:** none — PR #85 ready for review.

**Next session:** Phase A merge PR for #84.

## 2026-07-13 (night) — Issue #86: URLSearchParams body dropped to null → form-POST collision
**Duration:** ~15 min · **Branch:** `session/2026-07-13-1151-issue-86` · **PR:** #87

`readBodyAsText` decoded only `string`/`Uint8Array`/`ArrayBuffer` bodies; a `URLSearchParams` body (a standard `BodyInit` that `fetch` serializes as `application/x-www-form-urlencoded`) fell through to `null`, so every form POST looked like a no-body request. Two distinct form bodies (`foo=1` vs `bar=2`) hash-collided and one silently replayed the other's cassette (a false test pass — the repo's core failure mode); a form POST also collided with a no-body POST. Fixed by decoding via `body.toString()` (the exact wire bytes), so `normalizeRequest` tags it `raw` and folds it into the hash. `Blob`/`FormData`/`ReadableStream` stay a documented `null`-drop limitation (genuinely un-canonicalizable). This is the same body-discriminator collision class as #57 (raw-vs-JSON), #70/#71 (JSON-null-vs-no-body), and #84 (empty-string) — one body-type over. Verified firsthand end-to-end. One lock test; full suite (250) green, typecheck + lint clean.

**Why this work, this session:** Fifth (and final) hit of the night run — a second-order self-hunt on this run's own #84 empty-string fix, hunting the remaining body-normalization edge cases and verified firsthand before filing.

**Open questions / blockers:** none — PR #87 ready for review. (Independent of PR #85; trivial serial rebase at Phase-A merge time.)

**Next session:** Phase A merge PR for #86 (after #84's PR #85).

## 2026-07-14 (night) — Issue #88: non-Uint8Array typed-array bodies dropped to null → cassette collision
**Duration:** ~20 min · **Branch:** `session/2026-07-14-0516-issue-88` · **PR:** #89

`readBodyAsText` (`fetch-recorder.ts`) decoded only `Uint8Array` and `ArrayBuffer` bodies; every other `ArrayBufferView` — `DataView`, `Int8Array`, `Uint16Array`/`Int16Array`, `Float32Array`/`Float64Array`, a Node `Buffer`, etc. — fell through to `null`, byte-identical to a no-body request. Two distinct `Int16Array` bodies hash-collided and one replayed the other's cassette (the repo's core wrong-replay failure mode), and a view-body POST collided with a no-body POST. All of these are standard `BodyInit`s that `fetch` sends as their exact deterministic bytes, so — unlike `Blob`/`FormData`/`ReadableStream` (the documented un-canonicalizable out-of-scope limitation) — they can and should be hashed. Fixed by decoding any `ArrayBuffer.isView(body)` via `TextDecoder` (honoring the view's `byteOffset`/`byteLength`), so `normalizeRequest` tags it `raw` and folds it into the hash. This is the same body-discriminator collision class as #57 (raw-vs-JSON), #70/#71 (JSON-null), #84 (empty-string), and #86 (URLSearchParams) — one body-type over. Verified firsthand via a `tsx` repro: pre-fix two distinct `Int16Array` bodies wrote one cassette and replay served the wrong response; post-fix each records/replays its own and a no-body request correctly misses. One lock test; full suite (252) green, typecheck + lint clean.

**Why this work, this session:** First hit of the night run — surfaced by the ai-app body-collision sibling hunt on this run's own #84/#86 fixes and verified firsthand end-to-end before filing.

**Open questions / blockers:** none — PR #89 ready for review.

**Next session:** Phase A merge PR for #88.

## 2026-07-14 (night, issue #90) — Blob request bodies collide (sibling of #86/#88)

`readBodyAsText` in `src/fetch-recorder.ts` lumped `Blob` in with `ReadableStream`/`FormData` and dropped it to `null`, so a Blob request body never entered the request hash. That was wrong: a `Blob` is a fixed, deterministic byte container (no random multipart boundary — that's a FormData concept — and, unlike a stream, not single-read). `fetch` serializes it to its exact bytes and `await body.text()` reads them deterministically. Dropping to `null` made every Blob POST byte-identical to a no-body request, so two distinct Blob bodies hash-collided (one replayed the other's cassette) and a Blob POST collided with a no-body POST — the same collision class as #84 (empty-string), #86 (URLSearchParams), and #88 (typed-array views).

Fix: decode `Blob` bodies via `await body.text()`, mirroring the URLSearchParams/ArrayBufferView branches, so they're tagged `bodyEncoding:"raw"` and folded into the hash. `File extends Blob`, so File bodies ride the same branch. This also corrects the #88 memory note, which had assumed Blob was "by design" out of scope — only `ReadableStream` (single-read) and `FormData` (random multipart boundary) genuinely remain un-canonicalizable.

Verified firsthand with a Node ESM repro against `dist/`: pre-fix, 3 distinct requests wrote 1 cassette and a no-body replay served a Blob's response; post-fix, each distinct Blob records its own cassette, a no-body POST and a different Blob both raise `MissingCassetteError`, and the same Blob hits. Added a regression test; full suite (253), typecheck, and lint green. Shipped as PR #91.
