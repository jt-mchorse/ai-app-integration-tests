/**
 * Every test count the docs state is compared, not the first one (#141).
 *
 * Measured on `main`: README.md said `# 3 passed` directly under the documented
 * `npm run test:e2e` command while Playwright lists 6, because
 * `checkPlaywright` read only the first `the <N> Playwright` sentence; and
 * docs/architecture.md said "Three vitest suites in `example-app/test/`" over
 * six files.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  README_E2E_PASSED_RE,
  README_PLAYWRIGHT_RE,
  checkPlaywright,
} from "../tools/check-readme-test-count.mjs";

const ROOT = resolve(__dirname, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf-8");
const ARCH = readFileSync(join(ROOT, "docs", "architecture.md"), "utf-8");

function listingFile(name: string, n: number): string {
  const path = join(ROOT, "node_modules", ".cache", name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  const tests = Array.from({ length: n }, () => ({}));
  writeFileSync(path, JSON.stringify({ suites: [{ specs: [{ tests }] }] }), "utf-8");
  return path;
}

describe("the e2e command's `# N passed` line (#141)", () => {
  it("is present in the README (non-zero control)", () => {
    expect([...README.matchAll(README_E2E_PASSED_RE)].length).toBeGreaterThan(0);
  });

  it("agrees with the README's own Playwright sentence", () => {
    const sentence = Number(README_PLAYWRIGHT_RE.exec(README)![1]);
    for (const m of README.matchAll(README_E2E_PASSED_RE)) expect(Number(m[1])).toBe(sentence);
  });

  it("is compared against the listing even when the sentence is right", () => {
    const listed = Number(README_PLAYWRIGHT_RE.exec(README)![1]);
    const stale = README.replace(README_E2E_PASSED_RE, (m, n) => m.replace(`# ${n} passed`, "# 3 passed"));
    const r = checkPlaywright(listingFile("pw-e2e-stale.json", listed), stale);
    expect(r.code).toBe(1);
    expect(r.message).toContain("claims 3 Playwright tests");
  });
});

describe("docs/architecture.md names every example-app vitest suite (#141)", () => {
  const files = readdirSync(join(ROOT, "example-app", "test")).filter((f) => f.endsWith(".test.ts")).sort();
  const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

  it("states the right number of suites", () => {
    const m = /(\w+) vitest suites in `example-app\/test\/`/.exec(ARCH);
    expect(m, "the architecture doc no longer states a suite count").toBeTruthy();
    expect(m![1]).toBe(WORDS[files.length]);
  });

  it("lists each suite file by name", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(ARCH, `${f} is not described`).toContain(`**\`${f}\`**`);
  });
});
