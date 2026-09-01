/**
 * `scripts/missing_cassette_demo.ts` refuses a blank fixtures dir (#107).
 *
 * The guard was `!fixturesDir`, which is `false` for `"  "` — so a
 * whitespace-only value passed and reached `installFromEnv({ fixturesDir: "  " })`,
 * a fixtures directory literally named two spaces. Unset and `""` were both
 * correctly refused, which is exactly why it stayed quiet: the two cases anyone
 * would try by hand behave.
 *
 * `test/env-blank-rule-parity.test.ts` covers the rule; this file covers the
 * *script*, by spawning it. A unit test of the helper cannot show that the
 * script calls it, which is the half that regressed in
 * `agent-orchestration-platform#132` when a call site was reverted and only the
 * import remained.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "missing_cassette_demo.ts");
const EXPECTED = "MISSING_CASSETTE_DEMO_FIXTURES must be set";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function runWith(value: string | undefined) {
  const env = { ...process.env };
  if (value === undefined) delete env.MISSING_CASSETTE_DEMO_FIXTURES;
  else env.MISSING_CASSETTE_DEMO_FIXTURES = value;
  return spawnSync("npx", ["tsx", SCRIPT], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("MISSING_CASSETTE_DEMO_FIXTURES guard", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["one space", " "],
    ["two spaces", "  "],
    ["a tab", "\t"],
    ["a newline", "\n"],
    ["a no-break space", "\u00a0"],
  ])("exits 2 with the same message when it is %s", (_label, value) => {
    // "the same exit 2 and message as an unset one" is criterion 1 of #107:
    // a blank value must not get its own, more confusing failure further down
    // (a "no cassette found" naming a directory of spaces).
    const r = runWith(value);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(EXPECTED);
  });

  it("a real tempdir still reaches the demo's own success path", () => {
    // Anti-vacuous: a guard that rejected everything would pass every row
    // above. The script's success path is exit 0 with the caught
    // MissingCassetteError, which is the whole point of the demo.
    const dir = mkdtempSync(join(tmpdir(), "aiapp-missing-cassette-"));
    tempDirs.push(dir);
    const r = runWith(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("caught MissingCassetteError");
  });

  it("a padded but valid tempdir is TRIMMED, not passed through raw", () => {
    // Criterion 2, and the half that is easy to miss: rejecting blanks while
    // passing the raw string on would fix the rejection and keep the broken
    // path.
    //
    // Asserting exit 0 on a padded dir proves nothing — an *untrimmed* dir
    // also produces a MissingCassetteError and exit 0, because a directory
    // named "  /tmp/x  " simply has no cassettes in it either. The first draft
    // of this test made that mistake and passed against the un-fixed script.
    //
    // So give the directory something to find. Plant a cassette for the exact
    // request the demo issues, then run with the padded path: if the value is
    // trimmed the replayer finds it and the script takes its
    // "UNEXPECTED: request succeeded" branch (exit 3); if it is passed through
    // raw, the lookup misses and we get exit 0. The two outcomes are opposite,
    // so the assertion actually discriminates.
    const dir = mkdtempSync(join(tmpdir(), "aiapp-missing-cassette-"));
    tempDirs.push(dir);

    // The hash is read off the script's own output rather than hard-coded, so
    // a change to the demo request or to the hashing rule updates this test
    // instead of breaking it opaquely.
    const probe = runWith(dir);
    expect(probe.status).toBe(0);
    const hash = /hash ([0-9a-f]+)/.exec(probe.stdout)?.[1];
    expect(hash, `no request hash in:\n${probe.stdout}`).toBeTruthy();

    // Reuse a committed cassette's shape; only the identity fields matter for
    // the lookup, and `io.ts` checks that `request_hash` agrees with the
    // filename.
    const template = JSON.parse(
      readFileSync(join(REPO_ROOT, "fixtures", "a154fc0b65d0d40c779b713bd7b65138.json"), "utf8"),
    ) as { request_hash: string };
    template.request_hash = hash as string;
    writeFileSync(join(dir, `${hash}.json`), JSON.stringify(template, null, 2));

    const r = runWith(`  ${dir}  `);
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(3);
    expect(r.stdout).toContain("UNEXPECTED: request succeeded");
  });
});
