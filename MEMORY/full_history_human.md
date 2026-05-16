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
