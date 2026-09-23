#!/usr/bin/env node
//
// The README's vitest count is the number that actually ran (#119).
//
// `README.md`'s "Benchmarks / Results" section said "49 vitest tests run in
// ~340 ms". There were 492. Off by a factor of ten, in the section a reader
// goes to for numbers, and it drifted across every session that added a test
// because nothing was watching: `test/readme-snapshot.test.ts` pins quoted
// PATHS and `test/readme-decision-range.test.ts` pins the `D-NNN` range.
//
// THE UNIT IS THE TRAP, and it is live in this repo. Measured:
//
//     static `it(` / `test(` occurrences in test/   292
//     runtime executed cases                        492
//
// A 200-case gap, from `it.each` / `describe.each` parametrization. A lock
// written against the static count -- the obvious spelling, a grep -- would pin
// 292 and be confidently wrong by 200. That is exactly how five README counts
// in `mcp-server-cookbook` stayed green on wrong numbers for months (its
// D-011): a green lock on a wrong number is worse than no lock. So the unit
// here is *executed, non-skipped cases* -- the number `vitest run` prints and
// the number the README quotes -- and `check-readme-test-count.test.mjs`
// carries an arm asserting the static count is STRICTLY LESS than the pinned
// one, because equality of the two units IS the bug.
//
// The report is the one the suite already produces:
//
//     vitest run --reporter=json --outputFile=<path>   -> numPassedTests
//
// Extra flags on the run CI already performs, so nothing executes twice and no
// new job is needed. Model lifted from `mcp-server-cookbook`'s
// `tools/check-test-count.mjs`, which argued all of the above first.
//
// The DURATION is deliberately not checked. It is host-dependent, and a
// wall-clock assertion is the host-environment-assertion mistake; the README
// states it as an order of magnitude and says what it was measured on.
//
// Usage:
//   node tools/check-readme-test-count.mjs <report-path>
//
// Exit codes:
//   0 — the README's count matches what ran
//   1 — drift
//   2 — bad input (missing/unparseable report, no count in the README)
//
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const README_PATH = resolve(ROOT, "README.md");

// The sentence, matched on its own shape rather than on a fixed number: the
// count is what this check reads, so it cannot be part of the pattern.
export const README_COUNT_RE = /(\d[\d,]*)\s+vitest tests\b/;

/** The count the README claims, or null when the sentence is gone. */
export function readmeClaimedCount(readme) {
  const m = README_COUNT_RE.exec(readme);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** Executed, non-skipped cases in a vitest JSON report. */
export function executedCount(report) {
  if (typeof report?.numPassedTests !== "number") {
    throw new Error("report has no numeric numPassedTests");
  }
  return report.numPassedTests;
}

// The sentence also claims a FILE count and a Playwright count, in the same
// breath as the test count #119 pinned (#121). #119's own argument was about
// numbers generically -- "the two existing README locks pin quoted paths and the
// D-NNN range and neither covers a number" -- and it then pinned one of the three.
// The README says which omission is deliberate ("The duration is deliberately
// *not* pinned -- it is host-dependent"), which covers `~5.5 s` and `~5 s` and
// says nothing about `29 files` or `3`. Both are as host-independent as the test
// count and derivable from artifacts CI already produces.
export const README_FILES_RE = /\((\d[\d,]*)\s+files\b/;
export const README_PLAYWRIGHT_RE = /the\s+(\d[\d,]*)\s+Playwright\b/;

// The SECOND vitest suite -- `example-app/`, the demo application the harness is
// pointed at (#123). Two claims in one sentence: "of 53 tests in 5 files".
//
// #121 stated these numbers deliberately, concluding "the fix is to SAY WHICH IS
// WHICH and state the second suite's numbers so it exists where a check can
// see it". The stating half landed; nothing under `tools/` mentioned
// `example-app` at all, so the README sentence asserting a drift check could see
// the suite was false. These two were the only unpinned numbers left in the
// paragraph whose other three #119 and #121 each pinned.
export const README_EXAMPLE_APP_RE = /of\s+(\d[\d,]*)\s+tests\s+in\s+(\d[\d,]*)\s+files\b/;

/** Distinct test FILES in a vitest JSON report. */
export function fileCount(report) {
  // `testResults` is one entry per file. NOT `numTotalTestSuites`, which counts
  // `describe` blocks -- 113 against 29 files in this repo today. That field is
  // the plausible one and it has the wrong unit, which is exactly #119's lesson
  // ("a green lock on the wrong unit is worse than no lock"), so
  // `tools/check-readme-test-count.test.mjs` asserts the two differ and that this
  // function follows `testResults`.
  if (!Array.isArray(report?.testResults)) {
    throw new Error("report has no testResults array");
  }
  return new Set(report.testResults.map((t) => t?.name)).size;
}

/** Tests Playwright itself lists, from `--list --reporter=json` output. */
export function playwrightCount(listing) {
  // Playwright's own listing, not a grep for `test(`. A grep counts source
  // occurrences and cannot see `test.skip`, `test.describe` nesting, or a project
  // matrix that runs one spec twice -- the same reason #119 rejected a static
  // `it(` count, which would have pinned 292 against 503.
  const suites = Array.isArray(listing?.suites) ? listing.suites : [];
  let n = 0;
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) n += (spec.tests ?? []).length || 1;
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const s of suites) walk(s);
  return n;
}

/**
 * @param reportPath        vitest JSON report for the ROOT suite.
 * @param readme            README text (injectable for tests).
 * @param playwrightListPath optional `playwright test --list --reporter=json`
 *   output. Optional because it comes from a different command in a different
 *   package, so the root CI job can run this check without it; the `playwright`
 *   job passes it. When absent the Playwright claim is not checked, and
 *   `check-readme-test-count.test.mjs` asserts that the CI workflow DOES pass it
 *   somewhere -- otherwise "optional" would quietly mean "never checked", which
 *   is the shape #119 was.
 */
/**
 * Check only the README's Playwright claim, against Playwright's own listing.
 *
 * A separate entry point because the listing exists only in the `playwright` CI
 * job and the vitest report only in the root job -- neither job has both. Folding
 * it into `check()` as an optional argument and letting the root job pass nothing
 * would make "optional" mean "never checked in CI", which is the shape #119 was
 * and the `stuck-registration` fingerprint generally (#121).
 */
export function checkPlaywright(listingPath, readme = readFileSync(README_PATH, "utf8")) {
  let listing;
  try {
    listing = JSON.parse(readFileSync(listingPath, "utf8"));
  } catch (e) {
    return { code: 2, message: `cannot read the playwright listing at ${listingPath}: ${e.message}` };
  }
  const listed = playwrightCount(listing);
  const m = README_PLAYWRIGHT_RE.exec(readme);
  if (!m) {
    return {
      code: 2,
      message:
        "README.md no longer contains a `the <N> Playwright` claim. If the sentence " +
        "moved, update README_PLAYWRIGHT_RE; if it was removed on purpose, remove this check.",
    };
  }
  const claimed = Number(m[1].replace(/,/g, ""));
  if (claimed !== listed) {
    return {
      code: 1,
      message:
        `README.md claims ${claimed} Playwright tests; Playwright lists ${listed}.\n` +
        "The unit is what `playwright test --list` reports, not a grep for `test(` -- " +
        "a grep cannot see `test.skip` or a project matrix running one spec twice.",
    };
  }
  if (listed === 0) {
    return {
      code: 2,
      message:
        "Playwright listed 0 tests. A zero-vs-zero match would pass this check while " +
        "the e2e suite ran nothing, so it is an error rather than a pass.",
    };
  }
  return { code: 0, message: `check-readme-test-count: README's ${claimed} playwright match` };
}

/**
 * Check only the README's example-app claims, against that suite's own report.
 *
 * A separate entry point for the reason `checkPlaywright` is one: the report
 * exists only in the `example-app` CI job, and the root job's vitest report is a
 * different suite entirely. Folding it into `check()` as another optional
 * argument is what #121 warned makes "optional" mean "never checked in CI" --
 * and #121's own first draft additionally "referenced a report its job never
 * produces", so the `example-app` job now writes the report this reads.
 *
 * Both claims come from one sentence and are checked together, because a run
 * that moved the test count almost always moved the file count too and
 * reporting one at a time would cost two CI cycles.
 */
export function checkExampleApp(reportPath, readme = readFileSync(README_PATH, "utf8")) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (e) {
    return {
      code: 2,
      message: `cannot read the example-app vitest report at ${reportPath}: ${e.message}`,
    };
  }
  let ran;
  let files;
  try {
    ran = executedCount(report);
    files = fileCount(report);
  } catch (e) {
    return { code: 2, message: `${reportPath}: ${e.message}` };
  }
  // `0 == 0` is green while the suite ran nothing -- the same reason the
  // playwright mode refuses an empty listing. A suite that failed to load
  // reports zero, and zero is exactly the number a deleted claim would match.
  if (ran === 0 || files === 0) {
    return {
      code: 2,
      message:
        `${reportPath} reports ${ran} tests in ${files} files. A zero count means the ` +
        "suite did not run, not that it passed; refusing to compare it against the README.",
    };
  }
  const claimed = README_EXAMPLE_APP_RE.exec(readme);
  if (!claimed) {
    return {
      code: 2,
      message:
        "README.md no longer contains an `of <N> tests in <M> files` claim for the " +
        "example-app suite. If the sentence moved, update README_EXAMPLE_APP_RE; if it " +
        "was removed on purpose, remove this check -- but see #121 on why the second " +
        "suite is stated separately rather than folded into the harness's headline.",
    };
  }
  const claimedTests = Number(claimed[1].replace(/,/g, ""));
  const claimedFiles = Number(claimed[2].replace(/,/g, ""));
  if (claimedTests !== ran || claimedFiles !== files) {
    return {
      code: 1,
      message:
        `README.md claims the example-app suite is ${claimedTests} tests in ` +
        `${claimedFiles} files; ${ran} tests in ${files} files ran.\n` +
        "The units are executed, non-skipped cases and distinct files in the report's " +
        "`testResults` -- not `numTotalTestSuites`, which counts `describe` blocks. " +
        "Update the README's Benchmarks section to the measured numbers.",
    };
  }
  return {
    code: 0,
    message:
      `check-readme-test-count: README's example-app ${claimedTests} tests / ` +
      `${claimedFiles} files match`,
  };
}


export function check(
  reportPath,
  readme = readFileSync(README_PATH, "utf8"),
  playwrightListPath = null,
) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (e) {
    return { code: 2, message: `cannot read the vitest report at ${reportPath}: ${e.message}` };
  }
  let ran;
  try {
    ran = executedCount(report);
  } catch (e) {
    return { code: 2, message: `${reportPath}: ${e.message}` };
  }
  const claimed = readmeClaimedCount(readme);
  if (claimed === null) {
    return {
      code: 2,
      message:
        "README.md no longer contains a `<N> vitest tests` claim. If the sentence " +
        "moved, update README_COUNT_RE; if it was removed on purpose, remove this check.",
    };
  }
  if (claimed !== ran) {
    return {
      code: 1,
      message:
        `README.md claims ${claimed} vitest tests; ${ran} executed.\n` +
        "The unit is executed, non-skipped cases -- what `vitest run` prints. Update the " +
        "README's Benchmarks section to the measured number.",
    };
  }

  // The file count, from the same report (#121).
  let files;
  try {
    files = fileCount(report);
  } catch (e) {
    return { code: 2, message: `${reportPath}: ${e.message}` };
  }
  const claimedFiles = README_FILES_RE.exec(readme);
  if (!claimedFiles) {
    return {
      code: 2,
      message:
        "README.md no longer contains an `(<N> files` claim. If the sentence moved, " +
        "update README_FILES_RE; if it was removed on purpose, remove this check.",
    };
  }
  const claimedFileCount = Number(claimedFiles[1].replace(/,/g, ""));
  if (claimedFileCount !== files) {
    return {
      code: 1,
      message:
        `README.md claims ${claimedFileCount} test files; ${files} ran.\n` +
        "The unit is distinct files in the report's `testResults`, not " +
        "`numTotalTestSuites` (which counts `describe` blocks).",
    };
  }

  // The Playwright count, from Playwright's own listing (#121).
  let pwNote = "";
  if (playwrightListPath !== null) {
    let listing;
    try {
      listing = JSON.parse(readFileSync(playwrightListPath, "utf8"));
    } catch (e) {
      return {
        code: 2,
        message: `cannot read the playwright listing at ${playwrightListPath}: ${e.message}`,
      };
    }
    const listed = playwrightCount(listing);
    const claimedPw = README_PLAYWRIGHT_RE.exec(readme);
    if (!claimedPw) {
      return {
        code: 2,
        message:
          "README.md no longer contains a `the <N> Playwright` claim. If the sentence " +
          "moved, update README_PLAYWRIGHT_RE; if it was removed on purpose, remove " +
          "this check.",
      };
    }
    const claimedPwCount = Number(claimedPw[1].replace(/,/g, ""));
    if (claimedPwCount !== listed) {
      return {
        code: 1,
        message:
          `README.md claims ${claimedPwCount} Playwright tests; Playwright lists ${listed}.\n` +
          "The unit is what `playwright test --list` reports, not a grep for `test(` -- " +
          "a grep cannot see `test.skip` or a project matrix running one spec twice.",
      };
    }
    pwNote = ` / ${claimedPwCount} playwright`;
  }

  return {
    code: 0,
    message:
      `check-readme-test-count: README's ${claimed} tests / ${claimedFileCount} files` +
      `${pwNote} match what ran`,
  };
}

function main(argv) {
  if (argv[0] === "--example-app") {
    const reportPath = argv[1];
    if (!reportPath) {
      process.stderr.write(
        "usage: node tools/check-readme-test-count.mjs --example-app <vitest-report-json>\n",
      );
      return 2;
    }
    const { code, message } = checkExampleApp(reportPath);
    process.stdout.write(`${message}\n`);
    return code;
  }
  if (argv[0] === "--playwright") {
    const [, listingPath] = argv;
    if (!listingPath) {
      process.stderr.write(
        "usage: node tools/check-readme-test-count.mjs --playwright <playwright-list-json>\n",
      );
      return 2;
    }
    const r = checkPlaywright(listingPath);
    (r.code === 0 ? process.stdout : process.stderr).write(`${r.message}\n`);
    return r.code;
  }
  const [reportPath, playwrightListPath] = argv;
  if (!reportPath) {
    process.stderr.write(
      "usage: node tools/check-readme-test-count.mjs <vitest-report> [playwright-list-json]\n" +
        "   or: node tools/check-readme-test-count.mjs --playwright <playwright-list-json>\n",
    );
    return 2;
  }
  const { code, message } = check(reportPath, undefined, playwrightListPath ?? null);
  (code === 0 ? process.stdout : process.stderr).write(`${message}\n`);
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
