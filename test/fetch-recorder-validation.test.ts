/**
 * Factory-layer entry validation tests for `createRecorderFetch` /
 * `createReplayerFetch` (#34).
 *
 * Sibling to `validateHosts` in `src/install.ts` (#26) — that test
 * exercises the installer-layer gate; these exercise the factory-
 * layer gate immediately below it, so a direct caller (custom embed,
 * alternative install path) can't bypass the silent-pass-through
 * harm class that #26 closed at the installer layer.
 *
 * Tests never invoke a real fetch — the factory throws at construction
 * time on bad options, before any network surface is built.
 */
import { describe, expect, it } from "vitest";

import {
  type RecorderOptions,
  type ReplayerOptions,
  createRecorderFetch,
  createReplayerFetch,
  validateRecorderOptions,
  validateReplayerOptions,
} from "../src/fetch-recorder.js";
import { installRecorder, installReplayer, uninstall } from "../src/install.js";
import { CassetteStore } from "../src/io.js";

function makeStore(): CassetteStore {
  return new CassetteStore({ dir: "/tmp/ai-app-integration-tests-validation" });
}

function makeRecorderOptions(overrides: Partial<RecorderOptions> = {}): RecorderOptions {
  return {
    store: makeStore(),
    hosts: new Set(["api.anthropic.com"]),
    ...overrides,
  };
}

function makeReplayerOptions(overrides: Partial<ReplayerOptions> = {}): ReplayerOptions {
  return {
    store: makeStore(),
    hosts: new Set(["api.anthropic.com"]),
    ...overrides,
  };
}

describe("validateRecorderOptions — store", () => {
  it("accepts a CassetteStore instance", () => {
    expect(() => validateRecorderOptions(makeRecorderOptions())).not.toThrow();
  });

  it("rejects undefined store", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      validateRecorderOptions(makeRecorderOptions({ store: undefined as any })),
    ).toThrow(/store must be a CassetteStore-like object/);
  });

  it("rejects a plain object without read/write", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      validateRecorderOptions(makeRecorderOptions({ store: {} as any })),
    ).toThrow(/store must be a CassetteStore-like object/);
  });

  it("accepts a duck-typed store with read + write functions", () => {
    const ducktype = {
      read: async () => null,
      write: async () => "/tmp/x.json",
    };
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      validateRecorderOptions(makeRecorderOptions({ store: ducktype as any })),
    ).not.toThrow();
  });
});

describe("validateRecorderOptions — hosts", () => {
  it("rejects an empty Set (silent pass-through harm class #26 propagated)", () => {
    expect(() =>
      validateRecorderOptions(makeRecorderOptions({ hosts: new Set() })),
    ).toThrow(/hosts must be a non-empty Set/);
  });

  it("error message names the silent-pass-through harm", () => {
    expect(() =>
      validateRecorderOptions(makeRecorderOptions({ hosts: new Set() })),
    ).toThrow(/silently degrades the recorder to pass-through/);
  });

  it("rejects a non-Set hosts value", () => {
    expect(() =>
      validateRecorderOptions(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeRecorderOptions({ hosts: ["api.anthropic.com"] as any }),
      ),
    ).toThrow(/hosts must be a Set of hostnames/);
  });

  it("rejects an empty-string entry", () => {
    expect(() =>
      validateRecorderOptions(makeRecorderOptions({ hosts: new Set([""]) })),
    ).toThrow(/hosts entry #0 must be a non-empty string/);
  });

  it("rejects a non-string entry", () => {
    expect(() =>
      validateRecorderOptions(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeRecorderOptions({ hosts: new Set([42 as any]) }),
      ),
    ).toThrow(/hosts entry #0 must be a non-empty string/);
  });

  it("accepts a Set with one or many entries", () => {
    expect(() =>
      validateRecorderOptions(makeRecorderOptions({ hosts: new Set(["a.example"]) })),
    ).not.toThrow();
    expect(() =>
      validateRecorderOptions(
        makeRecorderOptions({ hosts: new Set(["a.example", "b.example"]) }),
      ),
    ).not.toThrow();
  });
});

describe("validateReplayerOptions — covers the same field set", () => {
  it("rejects empty hosts Set", () => {
    expect(() =>
      validateReplayerOptions(makeReplayerOptions({ hosts: new Set() })),
    ).toThrow(/hosts must be a non-empty Set/);
  });

  it("rejects missing store", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      validateReplayerOptions(makeReplayerOptions({ store: null as any })),
    ).toThrow(/store must be a CassetteStore-like object/);
  });

  it("accepts the happy path", () => {
    expect(() => validateReplayerOptions(makeReplayerOptions())).not.toThrow();
  });
});

describe("createRecorderFetch — gate fires at construction (before any fetch)", () => {
  it("rejects bad options at construction time", () => {
    expect(() => createRecorderFetch(makeRecorderOptions({ hosts: new Set() }))).toThrow(
      /hosts must be a non-empty Set/,
    );
  });

  it("returns a fetch on happy path", () => {
    const f = createRecorderFetch(makeRecorderOptions());
    expect(typeof f).toBe("function");
  });
});

describe("createReplayerFetch — gate fires at construction (before any fetch)", () => {
  it("rejects bad options at construction time", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createReplayerFetch(makeReplayerOptions({ store: undefined as any })),
    ).toThrow(/store must be a CassetteStore-like object/);
  });

  it("returns a fetch on happy path", () => {
    const f = createReplayerFetch(makeReplayerOptions());
    expect(typeof f).toBe("function");
  });
});

describe("installer-layer round-trips through the factory gate (acceptance regression)", () => {
  it("installRecorder happy path doesn't trip the factory gate", () => {
    expect(() => installRecorder({ hosts: ["api.anthropic.com"] })).not.toThrow();
    uninstall();
  });

  it("installReplayer happy path doesn't trip the factory gate", () => {
    expect(() => installReplayer({ hosts: ["api.anthropic.com"] })).not.toThrow();
    uninstall();
  });

  it("installRecorder still catches []-hosts at its outer #26 gate (deeper gate not reached)", () => {
    // Layered defense: the installer-layer #26 gate fires first with
    // its own message; the factory-layer #34 gate is the backstop for
    // direct factory callers.
    expect(() => installRecorder({ hosts: [] })).toThrow(
      /installRecorder: hosts must be a non-empty array/,
    );
  });
});
