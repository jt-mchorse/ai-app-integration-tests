# Architecture

The toolkit is a small TypeScript package that intercepts Node's global
`fetch` and routes calls to a recorder (writes cassette to disk) or a
replayer (reads cassette from disk). One package, one interception
point — no per-test plumbing, no MSW worker bootstrap.

```
ai-app-integration-tests/
├── src/
│   ├── cassette.ts          ← schema, normalization, hashing, redaction
│   ├── io.ts                ← CassetteStore (read/write JSON files)
│   ├── fetch-recorder.ts    ← wraps fetch: recorder + replayer
│   ├── install.ts           ← installFromEnv() + uninstall()
│   └── index.ts             ← public exports
├── test/
│   ├── cassette.test.ts     ← unit tests on hashing + redaction
│   ├── record-replay.test.ts← end-to-end record→replay round-trip
│   └── demo.test.ts         ← runs against a committed Anthropic-shaped fixture
├── fixtures/
│   └── <hash>.json          ← one file per recorded request
└── example-app/             ← Next.js 15 app under test (#4, peer subproject)
    ├── app/
    │   ├── page.tsx          home / nav
    │   ├── streaming/        SSE token streaming UI + /api/streaming route
    │   ├── tools/            tool-use UI + /api/tools route (2 tools)
    │   └── error/            error-path UI + /api/error route (3 failure kinds)
    └── test/
        ├── streaming-route.test.ts
        ├── tools-route.test.ts
        └── error-route.test.ts
```

## Three modes

```mermaid
flowchart LR
  ENV{ANTHROPIC_TEST_MODE}
  ENV -- live --> LIVE[pass-through to upstream]
  ENV -- record --> REC[recorder fetch]
  ENV -- replay --> REP[replayer fetch]

  REC --> UP[upstream API]
  UP --> CAS[(cassette write)]
  REP --> CAS_R[(cassette read)]
  CAS_R --> RESP[fake Response]
```

- **live** — `installFromEnv()` does nothing; tests hit the real API.
- **record** — recorder wraps `globalThis.fetch`. On every intercepted
  call it (a) re-issues the request to upstream, (b) captures the
  response (including SSE frames byte-for-byte), (c) redacts headers
  + scans for unredacted secrets, (d) writes
  `fixtures/<request-hash>.json`. The original caller sees the live
  response.
- **replay** — replayer wraps `globalThis.fetch`. On every intercepted
  call it computes the same request hash, reads the cassette, and
  rebuilds a `Response` (or a `Response` with a `ReadableStream` for
  SSE). Missing cassette throws `MissingCassetteError`.

Default mode is **replay** so CI never accidentally hits the live API.

## Request hashing (D-003)

The hash is `sha256(JSON.stringify({ method, url, body }))[:32]`, where:
- `url` has its query parameters sorted (so `?a=1&b=2` and `?b=2&a=1`
  hash equal).
- `body` is `canonicalize(parse(rawBody))` — JSON parsed, then keys
  sorted recursively. Arrays preserve order (sequence matters in
  `messages`).
- Headers are intentionally NOT in the hash. Header values vary across
  runs (timestamps, request IDs, key rotation) and would defeat
  cassette reuse.

This means two semantically-equivalent requests reuse the same cassette
even when the JSON shape differs in encoding (`{a:1,b:2}` vs `{b:2,a:1}`).

## Redaction (D-004)

Two checks run before any cassette is written:

1. **Header allowlist scrub.** `redactHeaders()` lower-cases every header
   name and replaces values for a denylist (`x-api-key`, `authorization`,
   `anthropic-api-key`, `openai-api-key`, `cookie`, etc.) with the
   string `[REDACTED]`.
2. **Body scan.** `assertNoLeakedSecrets()` serializes the entire
   cassette and rejects on three regexes: `sk-...`, `sk-ant-...`, and
   `Bearer <token>`. The check is intentionally broad — false positives
   are recoverable (rename the variable in your test); false negatives
   commit a credential to git.

The CI job `no-leaked-secrets` re-runs the body scan against every
committed cassette so a new leak in any future cassette fails the build.

## Missing cassette = loud failure (D-005)

In replay mode, a missing cassette throws `MissingCassetteError` with
the request hash and URL in the message. This is deliberate — the
alternative (silent fall-through to live) is worse:
- It hides test changes (someone tweaked a prompt; the cassette is
  stale; tests now hit the API and run a different assertion).
- It hides credential leaks (CI suddenly needs `ANTHROPIC_API_KEY`
  and the operator notices only when billing rises).

Loud failure means a test author who changes a prompt sees the test
fail with the new request hash and re-records:

```
ANTHROPIC_TEST_MODE=record ANTHROPIC_API_KEY=sk-... npm test -- demo
git add fixtures/<new-hash>.json
git rm fixtures/<old-hash>.json
```

## Why fetch-monkey-patch instead of MSW (D-002)

MSW is the canonical Node HTTP-interception library and is great when
you have multiple providers or arbitrary HTTP shapes. This repo
intercepts exactly one provider's API surface (Anthropic) and the
required behavior is small: hash, write, look up, replay, with SSE
support. Owning ~300 lines of fetch wrapper is cheaper than carrying
the MSW dep and the worker-vs-node split.

If a second provider lands, swapping to MSW is a one-file change inside
`fetch-recorder.ts` — the public API (`installRecorder` /
`installReplayer` / `installFromEnv` / `uninstall`) doesn't change.

## Example app under test (#4)

`example-app/` is a peer Next.js 15 (app router, React 19) subproject —
its own `package.json`, its own `node_modules`, so the toolkit's
runtime stays dep-clean per **D-006**. Three pages each backed by a
small route handler:

| Route          | What it does                                                                 |
| -------------- | ---------------------------------------------------------------------------- |
| `/streaming`   | Streams tokens via SSE; UI transitions `loading → first-token → done`.      |
| `/tools`       | Two tools (`get_weather`, `calculate`); UI renders tool calls + final answer.|
| `/error`       | Three failure kinds (`validation`, `upstream`, `shape`); UI renders envelope.|

The pages are client components driving `fetch` against their sibling
`/api/*` route handler, which uses the Anthropic SDK. Route handlers
are exported functions — tests import them directly and call with a
synthetic `Request`, no Next.js server needed.

Three vitest suites in `example-app/test/`:

- **`error-route.test.ts`** — no Anthropic call at all (validation +
  synthetic `shape` paths return early). 4 tests.
- **`streaming-route.test.ts`** — monkey-patches `globalThis.fetch` with
  a canned Anthropic SSE response (`message_start` →
  `content_block_delta`+ → `message_stop`); asserts the route emits one
  `data` frame per text delta plus a terminal `done` frame. 5 tests.
- **`tools-route.test.ts`** — sequences two canned responses (turn 1:
  `tool_use`, turn 2: final `text`); asserts both tool-routing paths
  (`calculate` for math, `get_weather` for cities) and the deterministic
  sandbox (`calculate` rejects non-arithmetic characters). 5 tests.

Run locally:

```bash
npm run example:install     # one-time: install example-app deps
npm run example:dev         # http://localhost:3000
npm run example:test        # 14 tests, no real API needed
```

Playwright integration tests across these screens are **#2**'s scope.
This PR ships the substrate.

## What this layer is NOT

- Not a Playwright test runner. Playwright tests on streaming UI states
  are issue **#2** and run *on top of* this layer (intercept the SDK
  calls inside the example app via this same install function).
- Not a flake-reduction library. Test stability is a downstream
  concern — this layer makes the API call deterministic, but
  `await page.waitForSelector(...)` policies live in #2.
