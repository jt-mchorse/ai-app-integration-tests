# CI timing & cache strategy

> Target: **< 5 minutes** total wall time on a warm-cache push (#5).

The CI workflow at [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
runs five jobs in parallel; the workflow's wall time is the longest of
them. Three jobs use caching; the other two are pure greps and run in
under 5s regardless.

## Caches and what each one buys

| Cache | Key on | What it skips | Warm-hit savings |
|---|---|---|---|
| **npm — toolkit** | `package-lock.json` | Network fetch + tarball extraction for every root dep | ~10–25s per `npm ci` |
| **npm — example-app** | `example-app/package-lock.json` | Same, for the Next/React/Playwright tree | ~30–60s per `npm ci` |
| **Next.js build cache** (`example-app/.next/cache`) | `example-app/package-lock.json` + every file under `app/`, `lib/`, `components/` | SWC compilation + webpack module graph rebuild | ~10–30s per `next build` on warm hit; on cold hit (one file changed under `app/`) the partial-restore key `restore-keys` still gives most of the speedup |
| **Playwright browsers** (`~/.cache/ms-playwright`) | Pinned to `@playwright/test`'s exact version | Chromium download (~165 MB) | ~30–45s per warm hit |

The npm caches are provided by [`actions/setup-node`'s built-in
`cache: "npm"`](https://github.com/actions/setup-node#caching-global-packages-data);
the Next and Playwright caches are explicit `actions/cache@v4` steps.

## Reading the timing summary

Each job ends with a `Job timing` step that does two things:

1. Emits a workflow `::notice` with the duration in seconds. These
   surface at the top of the run's "Summary" tab.
2. Appends a `**job:** \`Ns\`` row to `$GITHUB_STEP_SUMMARY`. The
   workflow summary then carries a per-job timing table that's visible
   to anyone clicking the run in the GitHub UI — no jq, no scrolling
   through logs.

The `playwright` job's summary line also includes
`pw-cache-hit=true|false` so an unusually slow run is debuggable from
the summary alone.

## Cache-invalidation rules of thumb

- **Changing a root package's version** (`package-lock.json` at the
  repo root): invalidates the toolkit npm cache only.
- **Changing an example-app package version**: invalidates the
  example-app npm cache, the Next.js cache, and any
  `@playwright/test` version bump separately invalidates the browser
  cache.
- **Changing a source file under `example-app/app/`, `lib/`, or
  `components/`**: the primary Next.js cache key misses, but the
  `restore-keys` fallback (same lockfile, any source hash) restores the
  most recent build cache. Webpack treats this as an incremental
  rebuild — most of the SWC work is preserved.

## Concurrency control

A workflow-level `concurrency` group keyed on `github.ref` cancels
stale runs when a newer push lands on the same branch. Saves up to a
full run's wall time on rapid push-on-push.

## Verification posture

The "under 5 minutes" goal is an *observed* target, not a configured
one. The acceptance criterion ("under 5 min on 5 consecutive runs")
requires watching five real runs after the timing instrumentation lands;
that's outside the scope of the PR that adds the instrumentation. After
the PR merges, the timing summary makes the verification one-click.
