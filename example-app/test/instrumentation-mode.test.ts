/**
 * The instrumentation hook cannot silently run against the live SDK (#101).
 *
 * `register()` used to read `(process.env.ANTHROPIC_TEST_MODE ?? "live")
 * .toLowerCase()` and then `if (mode !== "replay") return;`. Every value
 * outside the three-mode domain — a typo, a stray space out of a CI YAML
 * block, a set-but-empty variable — took the `return`, so no stub was
 * installed and the app ran against the real Anthropic API. The toolkit's
 * `installFromEnv` throws for the same inputs.
 *
 * The README states the contract this violated:
 *
 *   "missing cassette = loud failure ... (silent fall-through to live is
 *    forbidden)"
 *   "mode is environment-driven — ANTHROPIC_TEST_MODE is record | replay |
 *    live, defaulting to replay so CI never accidentally hits the real API"
 *
 * The hook had no test at all, which is why the drift survived. These assert
 * the hook's own behaviour; `test/test-mode-parity.test.ts` in the root suite
 * locks the shared rule against the toolkit's copy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STUB = vi.hoisted(() => ({ installed: 0 }));

vi.mock("../instrumentation-stub", () => ({
  installPlaywrightStub: () => {
    STUB.installed += 1;
  },
}));

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.ANTHROPIC_TEST_MODE;
  delete process.env.ANTHROPIC_TEST_MODE;
  STUB.installed = 0;
});

afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_TEST_MODE;
  else process.env.ANTHROPIC_TEST_MODE = saved;
});

async function register(value?: string): Promise<void> {
  if (value === undefined) delete process.env.ANTHROPIC_TEST_MODE;
  else process.env.ANTHROPIC_TEST_MODE = value;
  const mod = await import("../instrumentation");
  await mod.register();
}

describe("register() installs the stub", () => {
  it.each(["replay", "REPLAY", " replay", "replay ", "  RePlAy  "])(
    "for %j",
    async (value) => {
      await register(value);
      expect(STUB.installed).toBe(1);
    },
  );
});

describe("register() is a no-op only for the two documented cases", () => {
  it("when the variable is unset", async () => {
    await register(undefined);
    expect(STUB.installed).toBe(0);
  });

  it.each(["", "   ", "\t\n"])("when it is set-but-empty (%j), i.e. unset", async (value) => {
    await register(value);
    expect(STUB.installed).toBe(0);
  });

  it.each(["live", "LIVE", " live "])("when it is %j", async (value) => {
    await register(value);
    expect(STUB.installed).toBe(0);
  });

  it("when it is record — recording needs the real API by definition", async () => {
    await register("record");
    expect(STUB.installed).toBe(0);
  });
});

describe("register() refuses to guess", () => {
  it.each(["repaly", "relpay", "1", "true", "false", "stub", "mock", "replay,record"])(
    "throws on %j instead of silently going live",
    async (value) => {
      await expect(register(value)).rejects.toThrow(/ANTHROPIC_TEST_MODE must be/);
      expect(STUB.installed).toBe(0);
    },
  );

  it("says what the silent behaviour used to cost", async () => {
    await expect(register("repaly")).rejects.toThrow(/real Anthropic API/);
  });

  it("fails loudly rather than half-installing", async () => {
    // The throw happens before the dynamic import, so a rejected boot cannot
    // leave a partially-installed stub behind.
    await expect(register("stub")).rejects.toThrow();
    expect(STUB.installed).toBe(0);
  });
});

describe("the Playwright config's value works", () => {
  it("matches what playwright.config.ts sets", async () => {
    // The value the webServer env block passes. If someone changes it, this
    // fails here rather than as an inexplicable e2e timeout.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const config = readFileSync(resolve(__dirname, "..", "playwright.config.ts"), "utf8");
    const match = config.match(/ANTHROPIC_TEST_MODE:\s*"([^"]+)"/);
    expect(match, "playwright.config.ts no longer sets ANTHROPIC_TEST_MODE").not.toBeNull();

    await register(match![1]);
    expect(STUB.installed).toBe(1);
  });
});
