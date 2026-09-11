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

export function check(reportPath, readme = readFileSync(README_PATH, "utf8")) {
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
  return { code: 0, message: `check-readme-test-count: README's ${claimed} matches what ran` };
}

function main(argv) {
  const [reportPath] = argv;
  if (!reportPath) {
    process.stderr.write("usage: node tools/check-readme-test-count.mjs <report-path>\n");
    return 2;
  }
  const { code, message } = check(reportPath);
  (code === 0 ? process.stdout : process.stderr).write(`${message}\n`);
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
