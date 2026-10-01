/**
 * `.env.example` lists exactly the operator variables the code reads (#133).
 *
 * Handoff §10 says each repo gets a `.env.example`; this one had none. The set
 * is derived from source, so a new read fails here until it is listed, and a
 * listed variable nobody reads fails too.
 *
 * Comments are stripped before matching, and that is load-bearing here:
 * `src/fetch-recorder.ts` and `src/support/semantic-assert.ts` NAME
 * `RECORD_HOSTS` and `SEMANTIC_THRESHOLD` in comments, as examples of how a
 * caller might configure a value. Neither is read. The portfolio-ops#80 table
 * listed both for this repo because its sweep was a grep.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const SCOPE = ["src", "scripts", "example-app"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "test"]);

/**
 * Read by the code, but not configuration an operator supplies:
 * - `CI`: set by the runner; `playwright.config.ts` reads it.
 * - `MISSING_CASSETTE_DEMO_FIXTURES`: `scripts/capture_demo.sh` sets it for
 *   the demo script it runs, pointed at a fresh temp dir.
 */
const NOT_OPERATOR_CONFIG = new Set(["CI", "MISSING_CASSETTE_DEMO_FIXTURES"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(name) ? [] : sourceFiles(p);
    return /\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

export function stripComments(src: string): string {
  // Block comments, then `//` comments that start a line or follow whitespace.
  // The whitespace rule keeps `https://...` inside a string intact.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

export function envNamesRead(src: string): Set<string> {
  const code = stripComments(src);
  const names = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
    /readNonBlankEnv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) names.add(m[1]);
  return names;
}

function namesReadByRepo(): Set<string> {
  const names = new Set<string>();
  for (const dir of SCOPE) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      for (const n of envNamesRead(readFileSync(file, "utf8"))) names.add(n);
    }
  }
  return names;
}

function namesListed(): Map<string, string> {
  const text = readFileSync(join(ROOT, ".env.example"), "utf8");
  return new Map([...text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2]]));
}

describe(".env.example (#133)", () => {
  it("reads every spelling and ignores a name that is only in a comment", () => {
    const src = [
      "/** configure with `process.env.IN_A_JSDOC?.split(\",\")` */",
      "// threshold: Number(process.env.IN_A_LINE_COMMENT)",
      "const a = process.env.A_1;",
      'const b = process.env["B"];',
      'const c = readNonBlankEnv("C");',
      'const url = "https://example.com"; const d = process.env.AFTER_URL;',
    ].join("\n");
    expect([...envNamesRead(src)].sort()).toEqual(["AFTER_URL", "A_1", "B", "C"]);
  });

  it("the scan finds the operator reads and the excluded ones", () => {
    // A floor, so a scope or walk regression cannot make the equality below
    // compare two empty sets. The exclusions are asserted present too: an
    // exclusion for a name nobody reads is a stale entry.
    const read = namesReadByRepo();
    for (const n of ["ANTHROPIC_TEST_MODE", "ANTHROPIC_API_KEY", ...NOT_OPERATOR_CONFIG]) {
      expect(read, n).toContain(n);
    }
  });

  it("lists exactly the operator variables the code reads", () => {
    const read = [...namesReadByRepo()].filter((n) => !NOT_OPERATOR_CONFIG.has(n)).sort();
    expect([...namesListed().keys()].sort()).toEqual(read);
  });

  it("the key is a placeholder and the mode is a real mode", () => {
    const listed = namesListed();
    expect(listed.get("ANTHROPIC_API_KEY")).toContain("your-key-here");
    expect(["record", "replay", "live"]).toContain(listed.get("ANTHROPIC_TEST_MODE"));
  });
});
