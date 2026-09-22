/**
 * The README's vitest count is the number that actually ran (#119).
 *
 * `README.md`'s "Benchmarks / Results" section said "49 vitest tests run in
 * ~340 ms". There were 492 — off by a factor of ten, in the section a reader
 * goes to for numbers. It drifted across every session that added a test,
 * because nothing was watching: `readme-snapshot.test.ts` pins quoted PATHS
 * and `readme-decision-range.test.ts` pins the `D-NNN` range.
 *
 * **The unit is the trap, and it is live here.** Measured:
 *
 *     static `it(` / `test(` occurrences in test/   292
 *     runtime executed cases                        492
 *
 * A 200-case gap from `it.each` parametrization. A lock written against the
 * static count — the obvious spelling, a grep — would pin 292 and be
 * confidently wrong by 200, which is exactly how five README counts in
 * `mcp-server-cookbook` stayed green on wrong numbers for months (its D-011).
 * A green lock on a wrong number is worse than no lock. So
 * `test_the_static_count_is_strictly_less` below is not a curiosity: equality
 * of the two units IS the bug, and asserting strict inequality is what stops a
 * future edit re-freezing the wrong one.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  README_COUNT_RE,
  README_FILES_RE,
  README_PATH,
  README_PLAYWRIGHT_RE,
  ROOT,
  README_EXAMPLE_APP_RE,
  check,
  checkExampleApp,
  checkPlaywright,
  executedCount,
  fileCount,
  playwrightCount,
  readmeClaimedCount,
} from "../tools/check-readme-test-count.mjs";

const README = readFileSync(README_PATH, "utf-8");

/** A minimal vitest JSON report. */
function report(numPassedTests: number): string {
  const path = join(ROOT, "node_modules", ".cache", `probe-${numPassedTests}.json`);
  return path;
}

function writeReport(numPassedTests: number): string {
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const path = report(numPassedTests);
  mkdirSync(resolve(path, ".."), { recursive: true });
  // `testResults` carries the README's file claim too, since #121. Before that this
  // fixture was `{ numPassedTests, numPendingTests }` and `check()` read only the
  // first -- so completing it here is what keeps these rows about the TEST count
  // rather than about a report missing a field. The missing-field case has its own
  // row below, because "the report shape changed" is worth an exit 2 of its own.
  const claimedFiles = Number(README_FILES_RE.exec(README)?.[1] ?? 1);
  writeFileSync(
    path,
    JSON.stringify({
      numPassedTests,
      numPendingTests: 0,
      testResults: Array.from({ length: claimedFiles }, (_, i) => ({ name: `f${i}.test.ts` })),
    }),
    "utf-8",
  );
  return path;
}

describe("a report missing testResults", () => {
  it("exits 2 rather than silently skipping the file claim", () => {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const path = join(ROOT, "node_modules", ".cache", "probe-no-testresults.json");
    mkdirSync(resolve(path, ".."), { recursive: true });
    const claimedTests = readmeClaimedCount(README)!;
    writeFileSync(path, JSON.stringify({ numPassedTests: claimedTests }), "utf-8");
    const r = check(path, README);
    expect(r.code, "a report shape this check cannot read must be an error, not a pass").toBe(2);
    expect(r.message).toContain("testResults");
  });
});

describe("the README's claimed count", () => {
  it("is present and parseable", () => {
    const claimed = readmeClaimedCount(README);
    expect(claimed, "README has no `<N> vitest tests` claim").not.toBeNull();
    expect(claimed).toBeGreaterThan(0);
  });

  it("is matched on the sentence's shape, not on a fixed number", () => {
    // The count is what the check reads, so it cannot be part of the pattern.
    // If it were, the check would only ever confirm its own literal.
    expect(README_COUNT_RE.source).not.toMatch(/\d{2,}/);
    expect(readmeClaimedCount("we run 7 vitest tests here")).toBe(7);
    expect(readmeClaimedCount("we run 1,234 vitest tests here")).toBe(1234);
    expect(readmeClaimedCount("no claim at all")).toBeNull();
  });
});

describe("the check", () => {
  it("passes when the README matches the report", () => {
    const claimed = readmeClaimedCount(README) as number;
    expect(check(writeReport(claimed), README).code).toBe(0);
  });

  it("fails on drift, and names both numbers", () => {
    const claimed = readmeClaimedCount(README) as number;
    const result = check(writeReport(claimed + 1), README);
    expect(result.code).toBe(1);
    expect(result.message).toContain(String(claimed));
    expect(result.message).toContain(String(claimed + 1));
  });

  it("is red against the number the README actually shipped with", () => {
    // 49 vs 492. The regression this exists for, pinned as a row rather than
    // recounted in prose.
    const stale = README.replace(/\d[\d,]*\s+vitest tests/, "49 vitest tests");
    expect(readmeClaimedCount(stale)).toBe(49);
    expect(check(writeReport(492), stale).code).toBe(1);
  });

  it("exits 2 — not 0 — when the report is missing or unparseable", () => {
    // An input error must not read as a pass. A check that returns 0 when it
    // could not measure anything is the quietest way to stop checking.
    expect(check(join(ROOT, "does-not-exist.json"), README).code).toBe(2);
  });

  it("exits 2 when the README's claim is gone", () => {
    const gutted = README.replace(/\d[\d,]*\s+vitest tests/, "some vitest tests");
    expect(check(writeReport(492), gutted).code).toBe(2);
  });

  it("reads executed, non-skipped cases", () => {
    expect(executedCount({ numPassedTests: 42 })).toBe(42);
    expect(() => executedCount({})).toThrow(/numPassedTests/);
    expect(() => executedCount({ numPassedTests: "42" })).toThrow(/numPassedTests/);
  });
});

describe("the unit — the arm that stops the wrong number being re-frozen", () => {
  /** Occurrences of `it(` / `test(` at the start of a line in `test/`. */
  function staticOccurrences(): number {
    let n = 0;
    for (const name of readdirSync(join(ROOT, "test"))) {
      if (!name.endsWith(".ts")) continue;
      const text = readFileSync(join(ROOT, "test", name), "utf-8");
      n += (text.match(/^\s*(it|test)(\.each)?\(/gm) ?? []).length;
    }
    return n;
  }

  it("the static occurrence count is STRICTLY LESS than the pinned count", () => {
    // Equality is the bug. `it.each` turns one occurrence into many cases, so a
    // grep-based lock pins a number smaller than what runs — and reports green.
    // Strict inequality is what makes the two units impossible to confuse.
    const claimed = readmeClaimedCount(README) as number;
    const staticCount = staticOccurrences();
    expect(staticCount).toBeGreaterThan(0);
    expect(
      staticCount,
      `the static \`it(\`/\`test(\` count (${staticCount}) is not less than the ` +
        `pinned runtime count (${claimed}). If they are equal, either this repo ` +
        `stopped using it.each — in which case the two units coincide by accident ` +
        `and this arm no longer protects anything — or the README was pinned to ` +
        `the static count, which is the mcp D-011 failure mode.`,
    ).toBeLessThan(claimed);
  });

  it("the gap is large enough to matter, not a rounding artefact", () => {
    // Measured at 292 vs 492. Asserted as a floor rather than an exact figure,
    // so adding parametrized cases does not make this row churn.
    const claimed = readmeClaimedCount(README) as number;
    expect(claimed - staticOccurrences()).toBeGreaterThan(50);
  });

  it("the README says which unit it means", () => {
    // The number alone is re-derivable from a grep and would be re-derived
    // wrongly. The sentence has to name the unit for the next reader.
    // Whitespace-tolerant: the README wraps its prose, so the phrase spans a
    // newline. Matching on the literal would pin the line width, not the claim.
    const flat = README.replace(/\s+/g, " ");
    expect(flat).toMatch(/executed, non-skipped cases|what `vitest run` prints/);
  });
});


// ---------------------------------------------------------------------------
// The other two numbers in the same sentence (#121)
// ---------------------------------------------------------------------------
//
// #119 pinned the test count and its own argument was about numbers generically:
// "the two existing README locks pin quoted paths and the `D-NNN` range and
// neither covers a number". It then pinned one of three. The README names the
// deliberate omission -- "The duration is deliberately *not* pinned -- it is
// host-dependent" -- which covers `~5.5 s` and `~5 s` and says nothing about
// `29 files` or `3`.

function writeFullReport(numPassedTests: number, files: string[]): string {
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const path = join(ROOT, "node_modules", ".cache", `probe-full-${numPassedTests}-${files.length}.json`);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      numPassedTests,
      numPendingTests: 0,
      // 113 in this repo today, against 29 files: the plausible field with the
      // wrong unit.
      numTotalTestSuites: 113,
      testResults: files.map((name) => ({ name })),
    }),
    "utf-8",
  );
  return path;
}

describe("the file count", () => {
  it("is present and parseable in the README", () => {
    const m = README_FILES_RE.exec(README);
    expect(m, "the README no longer claims `(<N> files`").toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(0);
  });

  it("counts distinct files in testResults, NOT numTotalTestSuites", () => {
    // The near-miss worth a test. `numTotalTestSuites` counts `describe` blocks
    // and is 113 here; the claim is about files. A check that read the plausible
    // field would be green on a wrong number, which is #119's own lesson.
    const rpt = JSON.parse(
      readFileSync(writeFullReport(7, ["a.test.ts", "b.test.ts", "a.test.ts"]), "utf-8"),
    );
    expect(fileCount(rpt)).toBe(2);
    expect(rpt.numTotalTestSuites).toBe(113);
    expect(fileCount(rpt)).not.toBe(rpt.numTotalTestSuites);
  });

  it("passes when the README's file count matches the report", () => {
    const claimedTests = readmeClaimedCount(README)!;
    const claimedFiles = Number(README_FILES_RE.exec(README)![1]);
    const path = writeFullReport(
      claimedTests,
      Array.from({ length: claimedFiles }, (_, i) => `f${i}.test.ts`),
    );
    expect(check(path, README).code).toBe(0);
  });

  it("fails on file-count drift, and names both numbers", () => {
    const claimedTests = readmeClaimedCount(README)!;
    const claimedFiles = Number(README_FILES_RE.exec(README)![1]);
    const path = writeFullReport(
      claimedTests,
      Array.from({ length: claimedFiles + 1 }, (_, i) => `f${i}.test.ts`),
    );
    const r = check(path, README);
    expect(r.code).toBe(1);
    expect(r.message).toContain(String(claimedFiles));
    expect(r.message).toContain(String(claimedFiles + 1));
    expect(r.message).toContain("numTotalTestSuites");
  });

  it("exits 2 when the README's file claim is gone", () => {
    const claimedTests = readmeClaimedCount(README)!;
    const path = writeFullReport(claimedTests, ["only.test.ts"]);
    const stripped = README.replace(README_FILES_RE, "(many files");
    expect(check(path, stripped).code).toBe(2);
  });
});

describe("the Playwright count", () => {
  const listing = (specCount: number) => ({
    suites: [
      {
        specs: Array.from({ length: specCount }, () => ({ tests: [{}] })),
        suites: [],
      },
    ],
  });

  it("is present and parseable in the README", () => {
    const m = README_PLAYWRIGHT_RE.exec(README);
    expect(m, "the README no longer claims `the <N> Playwright`").toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(0);
  });

  it("counts what Playwright lists, walking nested suites", () => {
    expect(playwrightCount(listing(3))).toBe(3);
    expect(
      playwrightCount({
        suites: [{ specs: [{ tests: [{}] }], suites: [{ specs: [{ tests: [{}, {}] }] }] }],
      }),
      "a nested suite's specs must count, and a spec with two projects counts twice",
    ).toBe(3);
    expect(playwrightCount({ suites: [] })).toBe(0);
  });

  it("passes when the README matches the listing", () => {
    const claimed = Number(README_PLAYWRIGHT_RE.exec(README)![1]);
    const path = join(ROOT, "node_modules", ".cache", "pw-ok.json");
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(listing(claimed)), "utf-8");
    expect(checkPlaywright(path, README).code).toBe(0);
  });

  it("fails on drift, and names both numbers", () => {
    const claimed = Number(README_PLAYWRIGHT_RE.exec(README)![1]);
    const path = join(ROOT, "node_modules", ".cache", "pw-drift.json");
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(listing(claimed + 2)), "utf-8");
    const r = checkPlaywright(path, README);
    expect(r.code).toBe(1);
    expect(r.message).toContain(String(claimed));
    expect(r.message).toContain(String(claimed + 2));
  });

  it("exits 2 on a zero listing rather than matching zero against zero", () => {
    // A suite that fails to load lists nothing. Treating 0 === 0 as a pass is the
    // `Test Files is not Tests` trap: the check would be green while the e2e suite
    // ran nothing at all.
    const path = join(ROOT, "node_modules", ".cache", "pw-zero.json");
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ suites: [] }), "utf-8");
    const stripped = README.replace(README_PLAYWRIGHT_RE, "the 0 Playwright");
    expect(checkPlaywright(path, stripped).code).toBe(2);
  });

  it("exits 2 when the listing is missing or unparseable", () => {
    expect(checkPlaywright(join(ROOT, "node_modules", ".cache", "nope.json"), README).code).toBe(2);
  });
});

describe("the checks are wired into CI", () => {
  // A checker with an npm alias and no CI step passes locally forever and gates
  // nothing -- the `stuck-registration` fingerprint. The Playwright mode exists
  // only for the `playwright` job, so it is the one most easily left unwired, and
  // a first draft of that CI step ended in `|| true`, which would have gated
  // nothing at all (#121).
  const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf-8");

  it("the vitest/file check runs in CI", () => {
    expect(CI).toMatch(/node tools\/check-readme-test-count\.mjs\s+\/tmp\/vitest-report\.json/);
  });

  it("the --playwright mode runs in CI", () => {
    expect(CI).toMatch(/check-readme-test-count\.mjs --playwright/);
  });

  it("the CI step lists Playwright from example-app's own directory", () => {
    // `--prefix example-app` changes npm's package resolution and NOT the working
    // directory. Run from the repo root, `playwright test --list` finds no
    // `playwright.config.ts`, picks up the ROOT's vitest files instead, and reports
    // 0 suites with 34 load errors -- exiting 1 before the checker runs. That is how
    // this step failed in CI on its first push (#121); it passed locally only
    // because I had run it from inside `example-app`.
    //
    // The zero-listing guard in `checkPlaywright` would have caught the 0 as an
    // exit 2 if `bash -e` had not already failed on the npx exit code first, which
    // is why both exist.
    const step = CI.split("\n")
      .filter((l) => l.includes("playwright test --list"))
      .join("\n");
    expect(step, "the CI step no longer lists Playwright tests").not.toBe("");
    expect(step, "list Playwright from example-app's cwd, not via --prefix").toMatch(
      /cd example-app && npx playwright test --list/,
    );
    expect(step).not.toMatch(/--prefix example-app playwright test --list/);
  });

  it("no invocation is neutralised by `|| true`", () => {
    const lines = CI.split("\n").filter((l) => l.includes("check-readme-test-count.mjs"));
    expect(lines.length, "no invocations found at all").toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, `this invocation cannot fail CI: ${line.trim()}`).not.toMatch(/\|\|\s*true/);
    }
  });
});


describe("the example-app suite's two numbers (#123)", () => {
  // #121 concluded: "the fix is to SAY WHICH IS WHICH and state the second
  // suite's numbers so it exists where a check can see it." The stating half
  // landed and the check half did not -- nothing under `tools/` mentioned
  // `example-app` at all, while the README sentence asserted a drift check
  // could see the suite. These were the only two unpinned numbers left in a
  // paragraph whose other three #119 and #121 each pinned.
  const EXAMPLE_APP_CACHE = join(ROOT, "node_modules", ".cache");

  function writeExampleAppReport(tests: number, files: number, name = "ea"): string {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const path = join(EXAMPLE_APP_CACHE, `${name}-${tests}-${files}.json`);
    mkdirSync(EXAMPLE_APP_CACHE, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        numPassedTests: tests,
        numPendingTests: 0,
        // Deliberately MORE describe blocks than files, so a version reading
        // `numTotalTestSuites` would get a different answer and fail the
        // file-count arms below. #121's near-miss, kept live here.
        numTotalTestSuites: files * 3,
        testResults: Array.from({ length: files }, (_, i) => ({ name: `ea${i}.test.ts` })),
      }),
      "utf-8",
    );
    return path;
  }

  const claimed = README_EXAMPLE_APP_RE.exec(README);

  it("the README states both numbers in one sentence", () => {
    expect(claimed, "README.md no longer claims `of <N> tests in <M> files`").not.toBeNull();
  });

  const claimedTests = Number(claimed?.[1] ?? 0);
  const claimedFiles = Number(claimed?.[2] ?? 0);

  it("matches a report carrying exactly the claimed numbers", () => {
    const path = writeExampleAppReport(claimedTests, claimedFiles);
    expect(checkExampleApp(path, README).code).toBe(0);
  });

  it("fails when the test count drifts", () => {
    const path = writeExampleAppReport(claimedTests + 1, claimedFiles);
    const { code, message } = checkExampleApp(path, README);
    expect(code).toBe(1);
    expect(message).toContain(String(claimedTests));
  });

  it("fails when the FILE count drifts and the test count does not", () => {
    // The two are separable, and a check reading only the test count would pass
    // here -- which is the shape #119 left and #121 closed for the root suite.
    const path = writeExampleAppReport(claimedTests, claimedFiles + 1);
    expect(checkExampleApp(path, README).code).toBe(1);
  });

  it("refuses a zero count rather than reporting a match", () => {
    // `0 == 0` is green while the suite ran nothing. Same reasoning the
    // playwright mode already applies to an empty listing.
    const path = writeExampleAppReport(0, 0, "empty");
    const { code, message } = checkExampleApp(path, README);
    expect(code).toBe(2);
    expect(message).toContain("did not run");
  });

  it("exits 2 on a report with no testResults, rather than skipping", () => {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const path = join(EXAMPLE_APP_CACHE, "ea-shapeless.json");
    mkdirSync(EXAMPLE_APP_CACHE, { recursive: true });
    writeFileSync(path, JSON.stringify({ numPassedTests: 53, numPendingTests: 0 }), "utf-8");
    expect(checkExampleApp(path, README).code).toBe(2);
  });

  it("exits 2 when the README sentence is gone, rather than passing", () => {
    const path = writeExampleAppReport(claimedTests, claimedFiles);
    const stripped = README.replace(README_EXAMPLE_APP_RE, "of many tests in several files");
    const { code, message } = checkExampleApp(path, stripped);
    expect(code).toBe(2);
    expect(message).toContain("README_EXAMPLE_APP_RE");
  });

  it("the unit is distinct testResults names, not numTotalTestSuites", () => {
    // The fixture sets `numTotalTestSuites` to 3x the file count on purpose, so a
    // version that switched to the convenient field cannot pass this.
    const path = writeExampleAppReport(claimedTests, claimedFiles);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.numTotalTestSuites).not.toBe(claimedFiles);
    expect(fileCount(parsed)).toBe(claimedFiles);
  });

  it("does not read the ROOT suite's claim by accident", () => {
    // The root paragraph claims a different test count in the same README. A
    // regex that matched the root sentence would pass on a root-shaped report
    // and silently check the wrong suite.
    const rootClaim = Number(README_COUNT_RE.exec(README)?.[1]?.replace(/,/g, "") ?? 0);
    expect(rootClaim).toBeGreaterThan(0);
    expect(claimedTests).not.toBe(rootClaim);
    const rootShaped = writeExampleAppReport(rootClaim, claimedFiles, "rootshaped");
    expect(checkExampleApp(rootShaped, README).code).toBe(1);
  });
});

describe("the example-app check is wired into CI (#123)", () => {
  const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf-8");

  it("the --example-app mode runs in CI", () => {
    expect(CI).toMatch(/check-readme-test-count\.mjs --example-app/);
  });

  /** The lines of one top-level job, by name. */
  function jobLines(job: string): string[] {
    const lines = CI.split("\n");
    const start = lines.findIndex((l) => l === `  ${job}:`);
    expect(start, `no \`${job}\` job in ci.yml`).toBeGreaterThan(-1);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^ {2}\S/.test(l));
    return end === -1 ? rest : rest.slice(0, end);
  }

  it("the SAME job that runs the check also produces the report it reads", () => {
    // #121's Playwright step "referenced a report its job never produces". The
    // scope of that trap is the JOB, not the file -- jobs do not share /tmp, so
    // a path written by another job is exactly as absent as one written by
    // nobody.
    //
    // My first version of this arm checked only that *some* line in ci.yml
    // wrote the path, and it PASSED against a neighbour that pointed the check
    // at `/tmp/vitest-report.json` -- a real file, produced by the root job,
    // carrying the wrong suite's numbers. Scoping to the job is what makes it
    // discriminate.
    const lines = jobLines("example-app");
    const consumed = lines.map((l) => /--example-app (\S+)/.exec(l)).find(Boolean);
    expect(consumed, "the example-app job does not run the --example-app check").toBeTruthy();
    const path = consumed![1];
    const produced = lines.some((l) => l.includes(`--outputFile=${path}`));
    expect(produced, `the example-app job never writes ${path}`).toBe(true);
  });

  it("the check does not read a report produced by a different job", () => {
    // The root job writes /tmp/vitest-report.json, so pointing the example-app
    // check at it yields a readable file with the wrong suite's numbers --
    // which is the neighbour the arm above exists to reject.
    const lines = jobLines("example-app");
    const consumed = lines.map((l) => /--example-app (\S+)/.exec(l)).find(Boolean);
    expect(consumed![1]).not.toBe("/tmp/vitest-report.json");
  });

  it("the report is produced by the example-app suite, not the root one", () => {
    const producing = CI.split("\n").filter((l) => l.includes("--outputFile=/tmp/example-app-report.json"));
    expect(producing.length).toBeGreaterThan(0);
    for (const line of producing) {
      expect(line, `this writes the example-app report from the wrong suite: ${line}`).toContain(
        "--prefix example-app",
      );
    }
  });
});
