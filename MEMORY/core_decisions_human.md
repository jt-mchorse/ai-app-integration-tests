# Core Decisions

Strategic decisions for this repo, with reasoning. Append-only — superseded decisions are marked, not removed.

## D-001 — Scope locked to portfolio handoff §2 (2026-05-10)
**Decision:** Scope of this repo is fixed by the portfolio handoff document, section 2.

**Why:** The handoff spec was deliberated; ad-hoc scope expansion within a session is the failure mode this prevents.

**Alternatives considered:** None — this is a baseline.

**Reversibility:** Expensive. Scope changes require a deliberate revisit and a new decision entry.

**Related issues:** —

## D-002 — Fetch monkey-patch for interception, not MSW (2026-05-15)
**Decision:** The replay layer intercepts API calls by replacing Node's global `fetch` with a wrapper. MSW (Mock Service Worker) is rejected.

**Why:** This repo intercepts exactly one provider's API surface (Anthropic's `api.anthropic.com`) and the required behavior is small: hash, write, look up, replay, with SSE support. Owning ~300 lines of fetch wrapper is cheaper than carrying the MSW dep, the worker-vs-node split, and the mental model of "service worker" semantics. If a second provider lands, the public API (`installRecorder` / `installReplayer` / `installFromEnv` / `uninstall`) doesn't change — swapping to MSW is a one-file edit inside `fetch-recorder.ts`.

**Alternatives considered:**
- MSW — rejected as overkill for one provider; revisit if/when a second lands.
- nock — rejected because it intercepts `http.ClientRequest` (Node 20+ uses undici by default for global fetch, which nock doesn't reliably catch).
- undici's `MockAgent` — close call; rejected because it bypasses `fetch` shape entirely and tests-as-written would need to construct undici-style requests.

**Reversibility:** Cheap. One-file swap if priorities change.

**Related issues:** #1, #2

## D-003 — Cassette hash keyed on `{method, url, normalized-body}`, headers excluded (2026-05-15)
**Decision:** The cassette filename is `<sha256(...)>.json` where the hash input is `JSON.stringify({method, url, body})` after normalizing the URL (sort query params) and the body (sort object keys recursively, preserve array order). Headers are intentionally not in the hash.

**Why:** The intent of a request lives in the method, URL, and body. Headers vary across runs (timestamps, request IDs, key rotation, version pins) and would defeat cassette reuse if hashed. Two semantically-equivalent requests must reuse the same cassette.

**Alternatives considered:**
- Include headers in the hash — rejected because varying header values would create churn.
- Hash only the body — rejected because two endpoints (`/v1/messages` vs `/v1/messages?stream=true`) would collide.
- Hash the full serialized request — same churn problem as including headers.

**Reversibility:** Cheap. Changing the hash invalidates existing cassettes; that's a re-record on next test run.

**Related issues:** #1

## D-004 — Redaction is mandatory and runs before write; CI re-scans every committed cassette (2026-05-15)
**Decision:** The recorder runs two redaction layers before writing any cassette: (1) `redactHeaders()` replaces values for known sensitive headers (`x-api-key`, `authorization`, `anthropic-api-key`, `cookie`, etc.) with `[REDACTED]`; (2) `assertNoLeakedSecrets()` scans the entire serialized cassette against three regexes (`sk-...`, `sk-ant-...`, `Bearer <token>`) and throws if any match. The CI job `no-leaked-secrets` re-runs the regex scan against every committed cassette so a future leak fails the build.

**Why:** Leaked credentials must never reach git. The two-layer check is belt-and-suspenders: header allowlist scrubbing is the structured defense; the regex body-scan is the catch-all for credentials that leak through unexpected places (response bodies, error messages, log output captured into traces). False positives are recoverable (rename the variable in your test); false negatives commit a credential.

**Alternatives considered:**
- Post-commit scrub via `git filter-repo` — rejected because by then the credential is in git history.
- Manual review only — rejected because human reviewers miss leaks at scale.
- Header denylist without the body regex scan — rejected because a leak in a response body wouldn't be caught.

**Reversibility:** Cheap. Both layers are tunable.

**Related issues:** #1

## D-005 — Missing cassette in replay mode throws; no silent live fallback (2026-05-15)
**Decision:** When the replayer can't find a cassette for a given request, it throws `MissingCassetteError` with the request hash and URL. It does not silently fall through to the real API.

**Why:** Silent fall-through is the worst possible failure mode:
- It hides test changes — someone tweaks a prompt, the cassette is stale, the test now hits the live API and runs a different assertion. Tests pass for the wrong reason.
- It hides credential leaks — CI suddenly needs `ANTHROPIC_API_KEY` and the operator notices only when billing rises or rate limits hit.
- It hides cost spikes — an accidentally-uncached test in a tight loop bills hundreds of API calls per CI run.

Loud failure means the test author who changes a prompt sees the test fail with the new request hash and re-records explicitly. The recovery is a one-line command (`ANTHROPIC_TEST_MODE=record ANTHROPIC_API_KEY=sk-... npm test`).

**Alternatives considered:**
- Silent fall-through to live — rejected per above.
- Warn and fall through — rejected because warnings get ignored in CI logs.

**Reversibility:** Cheap.

**Related issues:** #1

## D-006 — Example app is a peer subproject under `example-app/`, not a root dep (2026-05-16)
**Decision:** The example Next.js app lives in `example-app/` with its own `package.json` and `node_modules`. The toolkit's root `package.json` does not depend on Next.js, React, or `@anthropic-ai/sdk`. Scripts at the root level (`example:install`, `example:dev`, `example:build`, `example:test`) proxy into the subproject.

**Why:** The toolkit is a *library* — anyone who installs `ai-app-integration-tests` should not pull Next.js + React + an LLM SDK as transitive deps just to use the fetch-replay layer. The example app is the *substrate the toolkit's patterns test against*, not part of the toolkit's API. Keeping the dep graphs separate honors that distinction and keeps `npm install` at the root fast. CI runs both jobs in parallel (`toolkit` and `example-app`); a future failure in one doesn't block the other.

**Alternatives considered:**
- Hoist Next.js into root devDeps — rejected: leaks unrelated deps into anyone who clones the toolkit for its library functionality.
- npm workspaces — rejected: more overhead than value for a single subproject; the root scripts proxy is two lines.
- Vendor the app source into `src/example-app/` — rejected: makes the toolkit's TS config straddle library and app concerns, which never ends well.

**Reversibility:** Cheap. A future workspace migration is mechanical.

**Related issues:** #4, #2

## D-007 — Example app uses Next.js 15 App Router (not Pages) (2026-05-16)
**Decision:** `example-app/` is Next.js 15 with the App Router and React 19. No Pages router. Server Components by default; client components are explicitly marked with `"use client"`.

**Why:** The handoff §2 #5 stack pins Next.js 15. App Router is the recommended path for new apps in the Next.js 15 era; aligning here keeps this repo and `nextjs-streaming-ai-patterns` (which it shares a stack with) on the same page. Streaming SSE through a route handler is straightforward in App Router; Server Actions and the rest of the React 19 surface are available if the example app ever needs them.

**Alternatives considered:**
- Pages Router — rejected: legacy, fewer first-class streaming primitives, diverges from sister repos.
- Remix — off-stack per handoff.
- Vite SSR — off-stack per handoff.

**Reversibility:** Cheap. The app is small enough that a router migration would be a 1–2 hour rewrite.

**Related issues:** #4

## D-008 — Playwright Anthropic stub via Next.js instrumentation hook, not the toolkit cassette layer (2026-05-16)
**Decision:** Playwright tests for the example-app's `/streaming` page get a deterministic Anthropic response from a `globalThis.fetch` interceptor installed in a Next.js `instrumentation.ts` hook. The interceptor routes the request to one of three canned SSE streams based on a keyword in the user prompt. The toolkit's cassette layer (D-001 through D-005 in this repo) is NOT used at the Playwright layer.

**Why:** The cassette layer hashes the exact request body the SDK sends, which means hand-authoring a cassette requires either a real recording (needs an API key budget) or a hand-computed hash that drifts whenever `@anthropic-ai/sdk` changes the wire shape. For three deterministic UI streams, a prompt-keyword stub is simpler, has zero hash drift, and the cassette layer's own scope (in-process vitest route tests + recorder mode for real captures) stays narrow. If Playwright tests later need to cover *real* recorded conversations (issue beyond #2), they can switch to the cassette layer via `installFromEnv()` in the same instrumentation hook — D-008 is a per-issue choice, not a repo-wide rejection.

**Alternatives considered:**
- Cassette layer with hand-authored cassettes — rejected; hash drift on SDK upgrades + maintenance cost.
- MSW or another third-party mock at the browser layer — rejected; adds a dep and lives in the wrong place (the SDK runs server-side in Next.js, so browser-layer mocks don't apply).
- Real Anthropic in CI with an API key — rejected; D-005 (no live API in CI) and budget concerns.

**Reversibility:** Cheap. The stub is ~150 lines in `example-app/instrumentation-stub.ts`; replacing it with `installFromEnv()` is a four-line edit in `instrumentation.ts` once recordings exist.

**Related issues:** #2

## D-009 — Flake classification is a caller-supplied callback; default treats network + 429/5xx as flake (2026-05-17)
**Decision:** `withRetryBudget` accepts an optional `classify(err, attempt) -> "flake" | "hard"` callback that decides per-error whether to retry. The default classifier treats `AbortError`, `TimeoutError`, `ECONNRESET/REFUSED/TIMEDOUT/ENOTFOUND`, `"fetch failed"`, and HTTP 429 / 5xx as flake; everything else as hard.

**Why:** Two pieces. **First**, "what counts as flake" varies by stack — one caller's `429` is a deliberate rate-limit signal they want to surface immediately; another caller's `429` is a backoff hint from a SaaS that'll succeed on retry. Hardcoding the classifier into the helper would force every caller of that other persuasion to wrap their fetch in custom error-rewriting logic, which is exactly the kind of "test-runtime helpers that own the stack" mistake the rest of the portfolio avoids. The classifier callback pushes the decision to the callsite where the context is visible. **Second**, most callers shouldn't have to think about this — the network families (`ECONNRESET` and friends) are universally transient, and HTTP 429 + 5xx are the documented Anthropic / OpenAI / Cohere retry signals. So the default classifier handles the 80% case; the override exists for the 20%. This is the same single-method-protocol seam pattern as `Embedder`, `Reranker`, `Generator`, `EscalationSignal`, `Backend`, et al across the portfolio.

**Alternatives considered:**
- Thrown-class hierarchy with a `FlakeMarker` — rejected. Requires callers to wrap third-party errors before throwing, which silently fails the "AbortError is flake" rule when the caller forgets to wrap (which they will).
- Hardcoded classifier in the helper — rejected. Loses per-callsite context; forces a fork every time a new stack convention shows up.
- No default classifier; every caller must configure — rejected. The network families are universal; making every caller wire them is gratuitous boilerplate that would land 30+ lines of `classify: (e) => isNetworkError(e) ? "flake" : "hard"` across the example app.

**Reversibility:** Cheap. The classifier is one function passed through; expanding the default set of recognized errors is a one-line addition with a regression test.

**Related issues:** #3

## D-010 — CI caching uses GitHub Actions built-ins only; per-job timing is exposed in the workflow Step Summary (2026-05-18)

**Decision:** CI caching uses `actions/cache@v4` for application-specific caches (Next.js build, Playwright browsers) and `actions/setup-node`'s built-in `cache: "npm"` for npm caches. No third-party caching layer. Each job ends with a `Job timing` step that emits a `::notice` and writes a `**job:** Ns` row to `$GITHUB_STEP_SUMMARY` — the playwright row also reports `pw-cache-hit=true|false`.

**Why:** The "under 5 minutes" target is an *observed* property, not a configured one. Tooling that hides the observation behind a third-party dashboard (Turbo Cloud, Nx Cloud, a self-hosted runner pool) trades visibility for an abstraction we don't need for a single-repo CI of five jobs. The built-in cache action is enough: its keying is granular (npm cache invalidates per-lockfile, Next.js cache invalidates per-source-tree-hash, Playwright invalidates per-pinned-version), and the cost is one declarative block per cache.

Exposing the timing in the Step Summary is the load-bearing piece: a future maintainer reading a failing run doesn't need to know `jq` or scroll through logs to see whether a slow run was a cache miss vs. a real regression. The summary row + the `cache-hit` output answer "was the cache warm?" in two clicks. Same posture as the rest of the portfolio — the demo's *behavior* is the artifact, not the infra.

The "5 consecutive runs under 5 min" acceptance is *post-merge*. This PR is the instrumentation; verification is operator-side. The summary makes the per-run check trivial.

**Alternatives considered:**
- Turbo / Nx / similar remote build cache — rejected: overkill for a single repo, adds infra surface (auth, retention, billing) that this repo doesn't need to teach.
- Self-hosted runners — rejected: out of scope for a hobby portfolio repo; runs against the "fresh-clone reproducibility" posture from D-003.
- Playwright sharding — rejected: the current e2e suite runs in seconds. Setup overhead of two parallel browser installs would exceed the parallelism win at this suite size. Revisit when e2e count grows.
- Caching `node_modules` directly instead of npm's global cache — rejected: brittle (npm's own integrity checks fight cached node_modules across versions); the npm cache action invalidates cleanly on lockfile change.

**Reversibility:** Cheap. Every cache block is independent and removable; removing one returns the affected job to its pre-#5 cold-cache baseline.

**Related issues:** #5

## D-011 — `scripts/capture_demo.sh` is the demo's source of truth; binary recording is a separate follow-up (2026-05-21)

**Decision:** The 60-second walkthrough demo is engineered as a deterministic bash driver (`scripts/capture_demo.sh`), a tsx helper that exercises the D-005 missing-cassette failure mode (`scripts/missing_cassette_demo.ts`), and a `spawnSync`-based smoke test (`test/capture-demo-smoke.test.ts`) that pins the script's contract surface-by-surface. The actual `docs/demo.{webm,mp4,gif}` binary commit + README embed is split into a separate issue (#16). The infrastructure lands now; the binary lands when someone has 30 min, Playwright chromium installed, and ffmpeg.

**Why:** What makes the demo durable is reproducibility — a behavior change to D-005 (cassette miss is fatal) or D-008 (Playwright stub via `instrumentation.ts`) must not silently leave the recording lying. The script + smoke test together are the reproducibility mechanism: surface 1's vitest invocation pins the cassette replay flow; surface 2 catches the actual `MissingCassetteError` from `src/fetch-recorder.ts` and prints its message (drift in either the helper or the error fires the test); surface 3's auto-skip branch keeps the script runnable in the toolkit CI job without adding Playwright to the root package or doubling the chromium cache. A committed binary without that infrastructure rots on the first D-005 / D-008 / stub-name refactor. Splitting also lets the binary step ride to an operational session — it needs a terminal recorder (asciinema or OBS), `npx --prefix example-app playwright install chromium` (~150 MB), and `ffmpeg` for size optimization — none of which CI cares about. Pattern mirrors D-012 in `nextjs-streaming-ai-patterns` and the equivalent decisions in `embedding-model-shootout`, `chunking-strategies-lab`, `vector-search-at-scale`, `python-async-llm-pipelines`, and `agent-orchestration-platform` that all landed earlier today.

**Alternatives considered:**
- Record the binary in this PR — rejected: requires Playwright browsers + ffmpeg + terminal recorder during a remote autonomous session; not reproducible in CI; the diff would be a binary instead of reviewable engineering.
- Ship only the binary, no script — rejected: the demonstration becomes oral tradition; first stub-name refactor silently breaks it; no test surface to catch drift.
- Fold the e2e surface into the smoke test directly — rejected: would force Playwright chromium installation into the toolkit CI job, doubling install time and browser cache storage. The dedicated `playwright` CI job already covers e2e; the capture script just has to be runnable without it.

**Reversibility:** Cheap. If we later want the binary committed in the same PR pattern, it's `bash scripts/capture_demo.sh | tee` → record → ffmpeg → `git add docs/demo.<ext>` + README embed away. The decision documents the *split*, not a hard line against committed binaries.

**Related issues:** #12, #16
