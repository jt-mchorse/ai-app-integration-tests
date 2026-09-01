/**
 * The blank-is-unset rule has two implementations, and they agree (#107).
 *
 * `parseTestMode` (#101) settled the rule for this repo: trim the value, treat
 * a blank one as unset. `scripts/missing_cassette_demo.ts` guarded with a bare
 * `!fixturesDir`, which is `false` for `"  "` — so a whitespace-only value
 * passed and reached `installFromEnv({ fixturesDir: "  " })`, a fixtures
 * directory literally named two spaces. Unset and `""` were both correctly
 * refused, which is what kept it quiet: the two cases anyone would try by hand
 * behave, and the one that arrives from a `.env` line does not.
 *
 * `src/env.ts` is the rule as its own function, and the script now uses it.
 * `parseTestMode` deliberately does *not* import it — see that module's
 * docstring: `src/test-mode.ts` and `example-app/test-mode.ts` are a mirrored
 * pair the example app structurally cannot break, and
 * `test/test-mode-parity.test.ts` holds the two hand-written copies to one
 * behaviour by executing both.
 *
 * So this file uses the same instrument on the axis this issue is about: one
 * matrix, both implementations, asserting they partition it the same way into
 * "unset" and "a value". Not a shared import — a shared *behaviour*, checked.
 */
import { describe, expect, it } from "vitest";

import { nonBlankEnv, readNonBlankEnv } from "../src/env.js";
import { parseTestMode } from "../src/test-mode.js";

/**
 * Values whose *blankness* is the question, independent of what any particular
 * variable's value domain is. Deliberately overlaps
 * `test/test-mode-parity.test.ts`'s matrix on the whitespace rows, since those
 * are the rows both rules have to agree on.
 */
const MATRIX: ReadonlyArray<string | undefined> = [
  undefined,
  "",
  " ",
  "  ",
  "\t",
  "\n",
  " \t\n ",
  "\u00a0", // NO-BREAK SPACE, written as an escape so an editor cannot silently eat it
  "\ufeff", // BOM: the realistic case, a .env saved as UTF-8-with-BOM
  "replay",
  " replay",
  "replay ",
  "  replay  ",
  "/tmp/fixtures",
  " /tmp/fixtures ",
  "0",
  "false",
  " . ",
];

/** Does `parseTestMode` consider this raw value *absent*? */
function testModeSaysUnset(raw: string | undefined): boolean {
  // `parseTestMode(raw, fallback)` returns the fallback exactly when it
  // considers the value absent, and never otherwise: every recognized value
  // returns itself and every unrecognized one throws. Using two different
  // fallbacks removes the coincidence where a raw value happens to equal one.
  try {
    return parseTestMode(raw, "live") === "live" && parseTestMode(raw, "record") === "record";
  } catch {
    return false; // unrecognized-but-present
  }
}

/** Does `src/env.ts` consider this raw value *absent*? */
const envSaysUnset = (raw: string | undefined): boolean => nonBlankEnv(raw) === undefined;

describe("the two blank-is-unset implementations agree", () => {
  it.each(MATRIX)("partitions %j the same way", (raw) => {
    expect(envSaysUnset(raw)).toBe(testModeSaysUnset(raw));
  });

  it("checks a matrix that actually contains both sides", () => {
    // Anti-vacuous: a matrix that had drifted to all-blank (or all-value)
    // would satisfy every row above while proving one half of the rule.
    const blanks = MATRIX.filter(envSaysUnset);
    expect(blanks.length).toBeGreaterThanOrEqual(8);
    expect(MATRIX.length - blanks.length).toBeGreaterThanOrEqual(6);
    // And the specific value that motivated #107 is in it.
    expect(MATRIX).toContain("  ");
  });
});

describe("nonBlankEnv", () => {
  it.each([undefined, "", " ", "  ", "\t\n"])("treats %j as unset", (raw) => {
    expect(nonBlankEnv(raw)).toBeUndefined();
  });

  it.each([
    ["/tmp/fixtures", "/tmp/fixtures"],
    [" /tmp/fixtures ", "/tmp/fixtures"],
    ["\t/tmp/fixtures\n", "/tmp/fixtures"],
    ["0", "0"],
    ["false", "false"],
  ])("returns %j trimmed as %j", (raw, expected) => {
    expect(nonBlankEnv(raw)).toBe(expected);
  });

  it("returns the TRIMMED value, which is half the fix", () => {
    // Rejecting blanks while handing back the untrimmed string would fix the
    // rejection and keep the broken path: `" /tmp/x "` joined into a filesystem
    // path becomes a *relative* path under a directory named one space. The
    // realistic input is not `"  "` on its own — it is a correct path carrying
    // incidental whitespace from a `.env` line or `$(cat path.txt)`.
    expect(nonBlankEnv(" /tmp/x ")).toBe("/tmp/x");
    expect(nonBlankEnv(" /tmp/x ")).not.toBe(" /tmp/x ");
  });

  it("does not treat a falsy-looking but real value as unset", () => {
    // The bare-`!value` guard's other failure mode, in the direction nobody
    // notices until a variable legitimately holds "0".
    expect(nonBlankEnv("0")).toBe("0");
    expect(nonBlankEnv("false")).toBe("false");
  });
});

describe("readNonBlankEnv", () => {
  it("reads from an injected env", () => {
    expect(readNonBlankEnv("X", { X: "  spaced  " })).toBe("spaced");
    expect(readNonBlankEnv("X", { X: "   " })).toBeUndefined();
    expect(readNonBlankEnv("X", {})).toBeUndefined();
  });

  it("defaults to process.env", () => {
    // The default parameter is what the script actually uses, so it needs its
    // own arm — every other case here injects.
    const saved = process.env.AIAPP_ENV_RULE_PROBE;
    try {
      process.env.AIAPP_ENV_RULE_PROBE = "  value  ";
      expect(readNonBlankEnv("AIAPP_ENV_RULE_PROBE")).toBe("value");
      process.env.AIAPP_ENV_RULE_PROBE = "   ";
      expect(readNonBlankEnv("AIAPP_ENV_RULE_PROBE")).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.AIAPP_ENV_RULE_PROBE;
      else process.env.AIAPP_ENV_RULE_PROBE = saved;
    }
  });
});
