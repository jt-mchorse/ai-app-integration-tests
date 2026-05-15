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
