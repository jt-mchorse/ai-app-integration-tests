/**
 * `ANTHROPIC_API_KEY=` used the empty string, not the placeholder (#102).
 *
 * All three routes did `process.env.ANTHROPIC_API_KEY ?? "test-key"`. `??`
 * fires on `null` / `undefined` only, so `ANTHROPIC_API_KEY=` — what
 * `docker run -e ANTHROPIC_API_KEY` with nothing after it produces, and what an
 * empty line in a `.env` file produces — reached the SDK as `""`. Measured
 * against the real SDK constructor:
 *
 *     value        result
 *     "test-key"   constructed, apiKey = "test-key"
 *     ""           constructed, apiKey = ""       <- the fallback did not fire
 *     "   "        constructed, apiKey = "   "    <- nor here
 *
 * **A diagnostic fix, not a correctness one, and the issue says so.** Under
 * `ANTHROPIC_TEST_MODE=replay` the instrumentation stub intercepts
 * `globalThis.fetch` and the key is never used — the path the placeholder
 * exists for. Outside it, `""` and `"test-key"` both fail to authenticate; only
 * the error text differs. What is worth fixing is "the fallback I wrote is not
 * the fallback that runs", repeated in three files.
 *
 * None of the three routes' key handling was covered before this file.
 */

import { describe, expect, it } from "vitest";

import { PLACEHOLDER_API_KEY, readApiKey } from "../api-key";

describe("readApiKey", () => {
  // (label, raw, expected) — the `??` rows are the ones that were wrong.
  const table: ReadonlyArray<readonly [string, string | undefined, string]> = [
    ["a real key", "sk-ant-real", "sk-ant-real"],
    ["the placeholder itself", "test-key", "test-key"],
    ["unset (undefined)", undefined, PLACEHOLDER_API_KEY],
    ["set-but-empty", "", PLACEHOLDER_API_KEY],
    ["a single space", " ", PLACEHOLDER_API_KEY],
    ["whitespace only", "   ", PLACEHOLDER_API_KEY],
    ["a tab", "\t", PLACEHOLDER_API_KEY],
    ["a newline", "\n", PLACEHOLDER_API_KEY],
    ["mixed whitespace", " \t\n ", PLACEHOLDER_API_KEY],
  ];

  it.each(table)("%s", (_label, raw, expected) => {
    expect(readApiKey(raw)).toBe(expected);
  });

  it("trims a key pasted with surrounding whitespace", () => {
    // A key out of a CI YAML block or a copy-paste should behave like the key,
    // not like a different one the API will reject.
    expect(readApiKey("  sk-ant-real  ")).toBe("sk-ant-real");
    expect(readApiKey("sk-ant-real\n")).toBe("sk-ant-real");
  });

  it("never returns an empty string", () => {
    for (const raw of [undefined, "", " ", "\t", "\n", "\r\n", " \t "]) {
      expect(readApiKey(raw).length).toBeGreaterThan(0);
    }
  });

  it("does not throw on a blank value, unlike parseTestMode", async () => {
    // The asymmetry is deliberate. An unrecognized ANTHROPIC_TEST_MODE could
    // mean a silent live run, which the README forbids, so `parseTestMode`
    // throws. An unset API key is the ordinary local-development state the
    // placeholder exists to serve.
    const { parseTestMode } = await import("../test-mode");
    expect(() => parseTestMode("nonsense", "live")).toThrow();
    expect(() => readApiKey("")).not.toThrow();
  });

  it("reads process.env when called with no argument", () => {
    const before = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = "";
      expect(readApiKey()).toBe(PLACEHOLDER_API_KEY);
      process.env.ANTHROPIC_API_KEY = "sk-from-env";
      expect(readApiKey()).toBe("sk-from-env");
      delete process.env.ANTHROPIC_API_KEY;
      expect(readApiKey()).toBe(PLACEHOLDER_API_KEY);
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it("the old expression really did differ, so the table is not vacuous", () => {
    // Recompute the `??` form and assert it disagrees on exactly the rows this
    // issue is about — otherwise a future edit could make every case above pass
    // while proving nothing.
    const oldWay = (raw: string | undefined) => raw ?? "test-key";
    const differs = table.filter(([, raw]) => oldWay(raw) !== readApiKey(raw)).map(([l]) => l);
    expect(differs).toEqual([
      "set-but-empty",
      "a single space",
      "whitespace only",
      "a tab",
      "a newline",
      "mixed whitespace",
    ]);
  });
});

describe("all three routes read the key the same way", () => {
  it("no route re-derives the expression", async () => {
    // The acceptance criterion "the three routes share one reader rather than
    // repeating the expression" — asserted against the sources, so a fourth
    // route copy-pasting the old form fails here.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));

    for (const route of ["streaming", "tools", "error"]) {
      const src = await readFile(
        resolve(here, "..", "app", "api", route, "route.ts"),
        "utf8",
      );
      expect(src, `${route} still reads process.env.ANTHROPIC_API_KEY directly`).not.toContain(
        "process.env.ANTHROPIC_API_KEY",
      );
      expect(src, `${route} does not use the shared reader`).toContain("readApiKey()");
    }
  });
});
