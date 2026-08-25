/**
 * The two `ANTHROPIC_TEST_MODE` readers agree (#101).
 *
 * `src/install.ts::installFromEnv` and `example-app/instrumentation.ts` both
 * read this variable, and they had drifted. The toolkit validated the domain
 * with a `switch` whose `default:` throws; the hook re-derived the rule as
 * `if (mode !== "replay") return;`. Measured on `main`:
 *
 *     value          instrumentation.register     installFromEnv
 *     ""             no-op -> LIVE SDK            THROWS
 *     "  "           no-op -> LIVE SDK            THROWS
 *     " replay"      no-op -> LIVE SDK            THROWS
 *     "replay "      no-op -> LIVE SDK            THROWS
 *     "repaly"       no-op -> LIVE SDK            THROWS
 *     "1"            no-op -> LIVE SDK            THROWS
 *     "true"         no-op -> LIVE SDK            THROWS
 *     "stub"         no-op -> LIVE SDK            THROWS
 *
 * 8 of 13 values disagreed, and every disagreement was in the unsafe
 * direction — a typo, a stray space out of a CI YAML block, or a set-but-empty
 * variable silently meant "run the Playwright suite against the real API".
 * The README calls that out explicitly: "silent fall-through to live is
 * forbidden", and "defaulting to `replay` so CI never accidentally hits the
 * real API".
 *
 * `example-app/` has its own `package.json` and cannot import this package, so
 * the rule is mirrored rather than shared. This file locks the mirror by
 * **executing both implementations** over the same matrix — a differential
 * test, not a text comparison, so a copy that is spelled differently but
 * behaves identically passes, and one that is spelled identically but was
 * edited in only one place fails.
 */

import { describe, expect, it } from "vitest";

import { TEST_MODES, parseTestMode, type TestMode } from "../src/test-mode.js";
import {
  TEST_MODES as MIRROR_TEST_MODES,
  parseTestMode as mirrorParseTestMode,
} from "../example-app/test-mode.js";

/** Every value worth asking about, including the eight that used to disagree. */
const MATRIX: (string | undefined)[] = [
  undefined,
  "",
  "  ",
  "\t\n",
  "replay",
  "REPLAY",
  "Replay",
  " replay",
  "replay ",
  "  replay  ",
  "record",
  "RECORD",
  "live",
  "Live",
  " live ",
  "repaly",
  "relpay",
  "1",
  "0",
  "true",
  "false",
  "stub",
  "mock",
  "replay,record",
];

function outcome(fn: typeof parseTestMode, raw: string | undefined, fallback: TestMode): string {
  try {
    return `mode:${fn(raw, fallback)}`;
  } catch (e) {
    return `throw:${(e as Error).message}`;
  }
}

describe("the two readers agree", () => {
  it("exposes the same domain", () => {
    expect([...MIRROR_TEST_MODES]).toEqual([...TEST_MODES]);
  });

  it.each(TEST_MODES)("agrees on every matrix value with fallback %s", (fallback) => {
    for (const raw of MATRIX) {
      expect(outcome(mirrorParseTestMode, raw, fallback), `value ${JSON.stringify(raw)}`).toBe(
        outcome(parseTestMode, raw, fallback),
      );
    }
  });

  it("checks a matrix large enough to be worth checking", () => {
    // Anti-vacuous: a parity assertion over an empty or tiny matrix proves
    // nothing, and this one has to cover the eight values that used to differ.
    expect(MATRIX.length).toBeGreaterThanOrEqual(20);
    for (const used_to_disagree of ["", "  ", " replay", "replay ", "repaly", "1", "true", "stub"]) {
      expect(MATRIX).toContain(used_to_disagree);
    }
  });
});

describe("the domain itself", () => {
  it.each(["record", "replay", "live"] as const)("accepts %s", (mode) => {
    expect(parseTestMode(mode, "live")).toBe(mode);
  });

  it.each(["REPLAY", " replay", "replay ", "  RePlAy  "])(
    "normalizes %j to replay rather than treating it as unrecognized",
    (raw) => {
      expect(parseTestMode(raw, "live")).toBe("replay");
    },
  );

  it.each([undefined, "", "   ", "\t\n"])("treats %j as unset and uses the fallback", (raw) => {
    expect(parseTestMode(raw, "live")).toBe("live");
    expect(parseTestMode(raw, "replay")).toBe("replay");
  });

  it.each(["repaly", "1", "true", "stub", "mock", "replay,record", "livee"])(
    "throws on %j rather than picking a branch",
    (raw) => {
      expect(() => parseTestMode(raw, "live")).toThrow(/ANTHROPIC_TEST_MODE must be/);
    },
  );

  it("names the harm, not just the domain", () => {
    // The message has to say why guessing is refused — the reader is someone
    // who typed a mode name and would otherwise assume "close enough".
    expect(() => parseTestMode("repaly", "live")).toThrow(/real Anthropic API/);
  });

  it("quotes the offending value verbatim, before normalization", () => {
    // `" replay "` normalizes; `" repaly "` does not, and the operator needs to
    // see the spaces to spot a CI YAML quoting mistake.
    expect(() => parseTestMode(" repaly ", "live")).toThrow(/" repaly "/);
  });
});

describe("the differing defaults are preserved on purpose", () => {
  it("is the only thing the two callers do differently", () => {
    // installFromEnv passes "replay" (a test tool: default to safe).
    // The instrumentation hook passes "live" (a production boot path: default
    // to not installing a stub). Both are correct; the drift was never here.
    expect(parseTestMode(undefined, "replay")).toBe("replay");
    expect(parseTestMode(undefined, "live")).toBe("live");
  });
});
