// Snapshot test for docs/architecture.md (#18, extended in #20).
//
// Before #18, the architecture doc was frozen at the substrate-only PR:
// the directory diagram listed src/ as 5 files and test/ as 3 (current
// reality: 6 and 8 plus a src/support/ flake-reduction subdir), the
// Example-app section said "Playwright tests are #2's scope, this PR
// ships the substrate" (Playwright shipped in #2 CLOSED on 2026-05-21,
// with example-app/e2e/streaming.spec.ts committed), and the "What
// this layer is NOT" section said the toolkit is "not a flake-reduction
// library" (flake-reduction shipped as src/support/{retry-budget,
// semantic-assert, wait-for}.ts and is documented in the README).
//
// This test locks the doc against re-drifting on five axes:
//
//   1. Every src/<file>.ts, src/support/<file>.ts, test/<file>.ts,
//      example-app/e2e/<file>.ts path token in the doc resolves on disk.
//   2. Four banned phrases — the exact shapes of pre-#18 staleness —
//      are absent. Matched case-insensitively so a future copy with
//      slight capitalization is still caught.
//   3. The doc references at least one src/support/ path and at least
//      one example-app/e2e/ path, so the inverse drift (someone trims
//      the diagram back to the substrate shape) also fails loudly.
//   4. (#20) Active-decision coverage: every non-superseded D-NNN >=
//      MIN_ACTIVE_DECISION_ID in MEMORY/core_decisions_ai.md is cited
//      somewhere in the doc. Mirrors the portfolio-wide upper-bound
//      axis shipped in eleven sister repos.
//   5. (#20) Closed-feature-issue coverage: every issue in
//      KNOWN_SHIPPED_ISSUES is referenced. A future sixth core
//      deliverable must bump the array AND add a doc reference.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

import * as SHARED from "./support/source-files.js";
import { sourceFiles } from "./support/source-files.js";

const ROOT = resolve(__dirname, "..");
const ARCH_PATH = resolve(ROOT, "docs/architecture.md");
const DECISIONS_PATH = resolve(ROOT, "MEMORY/core_decisions_ai.md");

// D-001 is the baseline "scope per handoff §2" entry every repo carries
// and isn't load-bearing in the per-layer text, so the lower bound is
// D-002. Hard-pinned in a dedicated `it()` below.
const MIN_ACTIVE_DECISION_ID = 2;

// Issues #1..#5 are the five core deliverables per portfolio handoff §2
// (deterministic Anthropic replay, Playwright streaming tests, flake
// reduction, example-app, CI under 5 min). A future sixth core
// deliverable must bump this array AND add a doc reference; the
// hard-pin test makes the former unmissable.
const KNOWN_SHIPPED_ISSUES: ReadonlyArray<number> = [1, 2, 3, 4, 5] as const;

// Exact substrings the pre-#18 doc carried that signaled drift. Each is
// the load-bearing fragment of one of the four stale claims.
const BANNED_PHRASES: ReadonlyArray<string> = [
  "Not a Playwright test runner",
  "Not a flake-reduction library",
  "Playwright tests on streaming UI states are issue",
  "This PR ships the substrate",
] as const;

/**
 * Extract path-like tokens from a markdown source. Catches:
 *   - src/foo.ts, src/support/foo.ts
 *   - test/foo.test.ts
 *   - example-app/e2e/foo.spec.ts (and other example-app subpaths)
 *
 * Tree-diagram-only entries (no leading slug, e.g. just "support/")
 * are intentionally not matched — the diagram is one source of refs,
 * but the doc text outside the fence is the canonical surface and
 * must reference paths in their slug-prefixed form for coverage.
 */
function pathTokens(md: string): string[] {
  const re = /(?:src|test|example-app)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|json|md)/g;
  const found = new Set<string>();
  for (const m of md.matchAll(re)) {
    found.add(m[0]);
  }
  return [...found].sort();
}

/**
 * Parse MEMORY/core_decisions_ai.md and return the sorted-ascending
 * array of integer ids for active (non-superseded) entries with id
 * `>= MIN_ACTIVE_DECISION_ID`. Regex-only; no YAML-parser dep.
 *
 * An entry missing `superseded_by:` is treated as active (matches
 * sister-repo behavior). The schema in practice always carries
 * `superseded_by: null` for active entries.
 */
function activeDecisions(): ReadonlyArray<number> {
  const text = readFileSync(DECISIONS_PATH, "utf8");
  const blocks = text.split(/\n(?=- id:)/);
  const out: number[] = [];
  for (const block of blocks) {
    const idMatch = block.match(/- id:\s*D-(\d+)/);
    if (!idMatch || idMatch[1] === undefined) continue;
    const supMatch = block.match(/superseded_by:\s*(\S+)/);
    const supValue = supMatch?.[1];
    const isActive =
      supValue === undefined || supValue.trim().toLowerCase() === "null";
    if (!isActive) continue;
    const n = Number.parseInt(idMatch[1], 10);
    if (Number.isFinite(n) && n >= MIN_ACTIVE_DECISION_ID) out.push(n);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

describe("docs/architecture.md is current with shipped scope (#18)", () => {
  const md = readFileSync(ARCH_PATH, "utf8");

  it("every src/, test/, example-app/ path token in the doc resolves on disk", () => {
    const tokens = pathTokens(md);
    expect(tokens.length, "expected the doc to reference at least one path").toBeGreaterThan(0);
    const missing = tokens.filter((t) => !existsSync(resolve(ROOT, t)));
    expect(
      missing,
      "architecture doc references paths that don't exist on disk: " +
        `${JSON.stringify(missing)}. Either fix the path or, if a file was ` +
        "intentionally renamed, update both the doc and any test that anchors on it.",
    ).toEqual([]);
  });

  it.each(BANNED_PHRASES)(
    "does not contain the stale phrase %j",
    (phrase: string) => {
      const lower = md.toLowerCase();
      const needle = phrase.toLowerCase();
      expect(
        lower.includes(needle),
        `architecture doc contains banned phrase "${phrase}", which was a ` +
          "specific shape of pre-#18 drift. If a different context legitimately " +
          "requires this string (e.g., a quoted example of what the doc used to " +
          "say), refactor the surrounding prose, or update BANNED_PHRASES with a comment.",
      ).toBe(false);
    },
  );

  it("BANNED_PHRASES is the exact set of four shapes from #18", () => {
    // Hard-pin so a future loose edit of this test can't silently drop one.
    expect([...BANNED_PHRASES]).toEqual([
      "Not a Playwright test runner",
      "Not a flake-reduction library",
      "Playwright tests on streaming UI states are issue",
      "This PR ships the substrate",
    ]);
  });

  it("doc references at least one src/support/ path (flake-reduction shipped)", () => {
    expect(
      md,
      "docs/architecture.md must reference at least one path under src/support/ — " +
        "the flake-reduction helpers ship today (retry-budget, semantic-assert, wait-for) " +
        "and are part of the core surface, not downstream concerns.",
    ).toMatch(/src\/support\//);
  });

  it("doc references at least one example-app/e2e/ path (Playwright shipped)", () => {
    expect(
      md,
      "docs/architecture.md must reference at least one path under example-app/e2e/ — " +
        "Playwright streaming tests shipped under #2 and live in example-app/e2e/, " +
        "not as a future / downstream concern.",
    ).toMatch(/example-app\/e2e\//);
  });

  it("every active core decision (D-NNN >= MIN_ACTIVE_DECISION_ID) is referenced (#20)", () => {
    const referenced = new Set<number>();
    for (const m of md.matchAll(/\bD-0*(\d+)\b/g)) {
      referenced.add(Number.parseInt(m[1]!, 10));
    }
    const missing = activeDecisions().filter((n) => !referenced.has(n));
    expect(
      missing,
      "docs/architecture.md doesn't cite these active (non-superseded) " +
        "core decisions even once. Every D-NNN in MEMORY/core_decisions_ai.md " +
        "should be referenced in the doc where the relevant code lives. " +
        "If a decision is genuinely not load-bearing here, supersede it; the " +
        "lock only honors active entries.",
    ).toEqual([]);
  });

  it("every shipped feature-issue in KNOWN_SHIPPED_ISSUES is referenced (#20)", () => {
    const referenced = new Set<number>();
    for (const m of md.matchAll(/#(\d+)\b/g)) {
      referenced.add(Number.parseInt(m[1]!, 10));
    }
    const missing = KNOWN_SHIPPED_ISSUES.filter((n) => !referenced.has(n));
    expect(
      missing,
      "docs/architecture.md doesn't reference these closed feature-issues. " +
        "Every entry in KNOWN_SHIPPED_ISSUES should be annotated in the " +
        "section that describes its surface (or the directory diagram).",
    ).toEqual([]);
  });

  it("MIN_ACTIVE_DECISION_ID is hard-pinned to 2 (#20)", () => {
    // D-001 is the baseline "scope per handoff §2" entry every repo carries
    // and isn't load-bearing in per-layer text. Hard-pinned so a future
    // loose edit can't widen the floor and silently drop decisions from
    // the coverage check.
    expect(MIN_ACTIVE_DECISION_ID).toBe(2);
  });

  it("KNOWN_SHIPPED_ISSUES is hard-pinned to [1..5] (#20)", () => {
    // The five core deliverables per portfolio handoff §2. A sixth
    // deliverable requires bumping this AND adding a doc reference;
    // this hard-pin makes the former unmissable.
    expect([...KNOWN_SHIPPED_ISSUES]).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// Symbol-resolution lock (portfolio-ops #55, TS side — #72).
//
// The axes above lock path tokens, banned phrases, subpath presence, active
// decisions, and shipped issues — but nothing checks that the *symbols* the
// doc names actually exist. The doc makes concrete claims about the code
// surface: `installFromEnv`, `redactHeaders`, `assertNoLeakedSecrets`,
// `MissingCassetteError`, `createRecorderFetch` / `createReplayerFetch`,
// `validateHosts`, `canonicalize`. A rename (say `redactHeaders` ->
// `scrubHeaders`) would leave the doc stale with CI green — the drift class
// portfolio-ops #55 catalogued portfolio-wide (e.g. llm-cost-optimizer's
// nonexistent `BatchAPIBackend`).
//
// This doc is CamelCase-identifier-rich, so it takes the same resolver shape
// as the nextjs-streaming-ai-patterns #76 sibling (not mcp-server-cookbook
// #82's tool-name approach): multi-word camel/Pascal inline-code identifiers,
// fenced blocks stripped, resolved against a static scan of every top-level
// declaration in `src/` (exported OR internal — the Python siblings resolve
// against the module's full attribute surface via `hasattr`, not just
// exports). Single lowercase words, SCREAMING_CASE env/const
// (`ANTHROPIC_TEST_MODE`), and snake_case SSE/tool tokens
// (`content_block_delta`, `get_weather`) are excluded as prose/wire noise.
// Two hard-pinned exception sets carry the non-declaration identifiers.

// Re-exported from the shared module so this file's existing references keep
// working and there is still exactly one definition (#117).
const { SOURCE_DIRS, SOURCE_EXTS } = SHARED;

// Framework / web / runtime globals the doc names in backticks that are NOT
// repo declarations. Multi-word only (a single-word `Response` / `Request`
// never enters the candidate set). Hard-pinned below.
const EXTERNAL_SYMBOLS: ReadonlyArray<string> = [
  "ReadableStream", // web streams API (replayer rebuilds SSE Response bodies)
  "globalThis", // JS global (the recorder/replayer wrap `globalThis.fetch`)
] as const;

// Illustrative pseudo-code identifiers the doc uses to *describe* behavior but
// that name no real declaration. `rawBody` appears only in the hashing prose
// (`canonicalize(parse(rawBody))`) as a stand-in for "the request body string"
// — verified absent from src/. Kept as an explicit, verified pin rather than
// loosening the candidate rule (which would also stop catching real drift).
const DOC_ILLUSTRATIVE: ReadonlyArray<string> = ["rawBody"] as const;

/** Strip fenced code blocks (``` ... ```), including the mermaid diagram and
 *  the bash/record snippets, so the backtick pairing for inline-code
 *  extraction can't desync on the triple fences. */
function stripFences(md: string): string {
  return md.replace(/```[\s\S]*?```/g, "");
}

/** True for a multi-word camelCase or PascalCase identifier — one with an
 *  internal lower->upper boundary (`installFromEnv`) or a Pascal-with-
 *  second-cap shape (`MissingCassetteError`). Single-word tokens return false. */
function isMultiWordIdentifier(tok: string): boolean {
  return /[a-z][A-Z]/.test(tok) || /[A-Z][a-z].*[A-Z]/.test(tok);
}

/** Multi-word camel/Pascal identifier candidates from the doc: fenced blocks
 *  stripped, then every inline-code span split into identifier tokens (dotted
 *  member refs split on `.`). Sorted unique. */
function candidateSymbols(md: string): string[] {
  const prose = stripFences(md);
  const out = new Set<string>();
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    for (const piece of m[1].split(/[^A-Za-z0-9_$]+/)) {
      for (const tok of piece.split(".")) {
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tok) && isMultiWordIdentifier(tok)) {
          out.add(tok);
        }
      }
    }
  }
  return [...out].sort();
}

// `sourceFiles` moved to `test/support/source-files.ts` (#117), unchanged.
// `proto-key-accumulators.test.ts` shipped a FLATTER answer to the same
// question one session after this one, and `src/support/` fell out of it. This
// walk is the shared definition now; sharing it is a no-op here, which the
// population assertions below pin.

/** Every top-level declaration name across the source dirs — exported or
 *  internal. The TS analogue of the Python resolver's module attribute
 *  surface. */
function repoDeclaredSymbols(): Set<string> {
  const decl =
    /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?(?:function\*?|const|let|var|class|type|interface|enum)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const names = new Set<string>();
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(dir)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(decl)) names.add(m[1]);
    }
  }
  return names;
}

/** Shared resolution path used by BOTH the live doc test and the inverse
 *  drift test, so the inverse test exercises the real resolver (not a
 *  re-implementation) and a resolver that resolves everything can't go
 *  vacuously green. Returns the candidates that resolve to nothing. */
function unresolvedSymbols(md: string, repoSymbols: Set<string>): string[] {
  const allowed = new Set<string>([...EXTERNAL_SYMBOLS, ...DOC_ILLUSTRATIVE]);
  return candidateSymbols(md).filter(
    (sym) => !repoSymbols.has(sym) && !allowed.has(sym),
  );
}

describe("docs/architecture.md names only symbols that exist (#72 / portfolio-ops #55)", () => {
  const md = readFileSync(ARCH_PATH, "utf8");
  const repoSymbols = repoDeclaredSymbols();

  it("extracts a non-empty candidate set (guards regex/extraction breakage)", () => {
    expect(candidateSymbols(md).length).toBeGreaterThan(0);
  });

  it("discovers the repo's real declarations as ground truth", () => {
    // Sanity floor on the source scan: these are named in the doc's prose and
    // known to exist. If the scan regresses to empty/tiny, the resolution test
    // would false-flag everything — catch it here with a legible message.
    for (const known of ["installFromEnv", "redactHeaders", "MissingCassetteError", "canonicalize"]) {
      expect(repoSymbols.has(known), `expected repo declaration '${known}' in the source scan`).toBe(true);
    }
  });

  it("every multi-word symbol the doc names resolves to a declaration or a pinned exception", () => {
    const unresolved = unresolvedSymbols(md, repoSymbols);
    expect(
      unresolved,
      `docs/architecture.md names these multi-word identifiers that resolve to no ` +
        `top-level declaration in src/, and are not in EXTERNAL_SYMBOLS or ` +
        `DOC_ILLUSTRATIVE: ${JSON.stringify(unresolved)}. Either fix the doc, or ` +
        `(if the symbol is a genuine runtime global / illustrative pseudo-code ` +
        `token) add it to the matching pinned set.`,
    ).toEqual([]);
  });

  it("flags an injected drifted symbol while a real one in the same text resolves (inverse safety net)", () => {
    // Prove the resolver rejects a nonexistent symbol — otherwise the green
    // above could be vacuous. `redactHeadersXYZ` is not a declaration, not
    // external, not illustrative; `redactHeaders` is a real export. Same code
    // path as the live test.
    const injected = "the real `redactHeaders` sits next to a drifted `redactHeadersXYZ`";
    const unresolved = unresolvedSymbols(injected, repoSymbols);
    expect(unresolved).toContain("redactHeadersXYZ");
    expect(unresolved).not.toContain("redactHeaders");
  });

  it("EXTERNAL_SYMBOLS is the exact pinned set", () => {
    expect([...EXTERNAL_SYMBOLS]).toEqual(["ReadableStream", "globalThis"]);
  });

  it("DOC_ILLUSTRATIVE is the exact pinned set", () => {
    expect([...DOC_ILLUSTRATIVE]).toEqual(["rawBody"]);
  });

  it("SOURCE_DIRS is the exact pinned set", () => {
    // The ground-truth scan root. example-app/ is a peer subproject with its
    // own tree; widening to it (to resolve an example-app symbol the doc might
    // name) should be an intentional edit, not silent drift.
    expect([...SOURCE_DIRS]).toEqual(["src"]);
  });
});

// ---------------------------------------------------------------------------
// Example-app tool-name resolution (portfolio-ops #55 follow-on — #74).
//
// The CamelCase resolver above deliberately excludes snake_case tokens, so the
// doc's *example-app tool claims* were still unlocked. The "Example app under
// test" section states `/tools` ships "Two tools (`get_weather`, `calculate`)"
// — snake_case names registered as `name: "..."` in the example-app route
// handlers. A handler renaming `get_weather` -> `weather` would leave the
// doc's claim stale with CI green: the same drift class #55 targets, on the
// peer subproject's tool surface. This is the mcp-server-cookbook #82
// tool-name approach applied here (snake_case tool-name resolution, not the
// CamelCase identifier resolver), scoped to the example-app's API routes.

const EXAMPLE_API_DIR = "example-app/app/api";

/** Extract the tool names the doc claims the example app exposes, from its own
 *  `N tools (`a`, `b`)` declaration syntax. Anchoring on that frame keeps the
 *  candidate set precise — it doesn't sweep in the many other backticked
 *  snake_case tokens the doc names (`content_block_delta`, `message_stop`,
 *  `validation`, `upstream`, `shape`), which are SSE event kinds and
 *  error-kind union members, not tools. */
function docToolClaims(md: string): string[] {
  const claims = new Set<string>();
  for (const list of md.matchAll(/\btools?\s*\(([^)]*)\)/g)) {
    for (const t of list[1].matchAll(/`([a-z][a-z0-9_]*)`/g)) claims.add(t[1]);
  }
  return [...claims].sort();
}

/** Every tool name registered as `name: "..."` in the example-app API route
 *  handlers — the ground truth a doc tool-claim must resolve against. Scanned
 *  from `example-app/app/api/**​/*.ts`, test files excluded. */
function registeredExampleTools(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    const abs = resolve(ROOT, dir);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".ts") && !/\.test\.ts$/.test(entry.name)) {
        const text = readFileSync(resolve(ROOT, rel), "utf8");
        for (const m of text.matchAll(/\bname\s*:\s*"([a-z][a-z0-9_]*)"/g)) names.add(m[1]);
      }
    }
  };
  walk(EXAMPLE_API_DIR);
  return names;
}

/** Shared resolver used by both the live and inverse tests. */
function unresolvedTools(md: string, registered: Set<string>): string[] {
  return docToolClaims(md).filter((t) => !registered.has(t));
}

describe("docs/architecture.md example-app tool claims resolve (#74 / portfolio-ops #55)", () => {
  const md = readFileSync(ARCH_PATH, "utf8");
  const registered = registeredExampleTools();

  it("discovers the example-app's registered tools as ground truth", () => {
    // Floor on the scan: get_weather / calculate are registered in
    // example-app/app/api/tools/route.ts. If the walk regresses, the
    // resolution below would false-flag — catch it here.
    expect(registered.has("get_weather")).toBe(true);
    expect(registered.has("calculate")).toBe(true);
  });

  it("every tool the doc claims the example app exposes is registered", () => {
    const unresolved = unresolvedTools(md, registered);
    expect(
      unresolved,
      `docs/architecture.md claims example-app tools that no route handler registers: ` +
        `${JSON.stringify(unresolved)}. Every tool named in an "N tools (...)" list must ` +
        `appear as name: "..." in example-app/app/api/. Fix the doc or the registration.`,
    ).toEqual([]);
  });

  it("flags a drifted tool claim while a real one resolves (inverse safety net)", () => {
    const claims = docToolClaims("two tools (`get_weather`, `calculaate`)");
    const reg = new Set(["get_weather", "calculate"]);
    expect(unresolvedTools("two tools (`get_weather`, `calculaate`)", reg)).toEqual(["calculaate"]);
    expect(claims).toContain("get_weather");
  });

  it("EXAMPLE_API_DIR is the exact pinned scan root", () => {
    expect(EXAMPLE_API_DIR).toBe("example-app/app/api");
  });
});
