import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const README_PATH = resolve(ROOT, "README.md");

const README = readFileSync(README_PATH, "utf-8");

describe("README references real files on disk", () => {
  const expectedPaths = [
    "example-app/e2e/streaming.spec.ts",
    "example-app/instrumentation-stub.ts",
    "test/demo.test.ts",
    "src/support/",
  ];

  for (const rel of expectedPaths) {
    it(`README mentions "${rel}" and the file exists`, () => {
      const trimmedRel = rel.endsWith("/") ? rel.slice(0, -1) : rel;
      expect(README, `README does not reference ${rel}`).toMatch(rel);
      expect(existsSync(resolve(ROOT, trimmedRel)), `${rel} not on disk`).toBe(true);
    });
  }
});

describe("README references real npm scripts", () => {
  const ROOT_PKG = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
    scripts?: Record<string, string>;
  };
  const EXAMPLE_PKG = JSON.parse(
    readFileSync(resolve(ROOT, "example-app/package.json"), "utf-8"),
  ) as { scripts?: Record<string, string> };
  const rootScripts = new Set(Object.keys(ROOT_PKG.scripts ?? {}));
  const exampleScripts = new Set(Object.keys(EXAMPLE_PKG.scripts ?? {}));

  it("every `npm run <name>` in the README resolves to a real script", () => {
    const re = /npm run ([\w:-]+)(?:\s+--prefix\s+example-app)?/g;
    const hits = [...README.matchAll(re)];
    expect(hits.length, "no `npm run …` invocations found in README").toBeGreaterThan(0);
    for (const m of hits) {
      const name = m[1] ?? "";
      const usesPrefix = /--prefix\s+example-app/.test(m[0]);
      const scripts = usesPrefix ? exampleScripts : rootScripts;
      expect(
        scripts.has(name),
        `README references \`${m[0]}\` but no such script exists in ${usesPrefix ? "example-app/package.json" : "root package.json"}`,
      ).toBe(true);
    }
  });
});

describe("README has no hard-coded specific test count", () => {
  // Drift-prevention: a number like "24 tests" / "49 tests" pinned in the
  // Quickstart code block silently rots. Allow narrative numbers in the
  // Benchmarks/Results block, but disallow specific N-tests-pass claims in
  // bash/quickstart code fences.
  it("Quickstart code fences contain no `# <N> tests pass` comments", () => {
    const fences = [...README.matchAll(/```bash([\s\S]*?)```/g)];
    expect(fences.length, "expected at least one bash fence in the README").toBeGreaterThan(0);
    for (const m of fences) {
      const body = m[1] ?? "";
      // Specifically prohibit "# <digits> tests" comments inside bash fences.
      const drift = body.match(/#\s*\d+\s+tests?\b/);
      expect(
        drift,
        `bash fence contains a hard-coded test-count comment: ${drift?.[0]}`,
      ).toBeNull();
    }
  });
});
