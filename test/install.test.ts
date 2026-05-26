import { afterEach, describe, expect, it } from "vitest";

import { installRecorder, installReplayer, uninstall } from "../src/install.js";

// All tests reset the install state so the suite ordering doesn't matter.
afterEach(() => {
  uninstall();
});

// Issue #26: installRecorder / installReplayer validate the `hosts` option
// at entry. Before #26, `?? DEFAULT_HOSTS` only short-circuited on
// `undefined`; passing `hosts: []` produced an empty intercept Set, every
// fetch fell through to upstream, and tests pass green while actually
// hitting live APIs — same harm class as D-005 (`missing-cassette-is-fatal`)
// but at the install layer.

describe("installRecorder — hosts validation (issue #26)", () => {
  it("rejects empty hosts array", () => {
    expect(() => installRecorder({ hosts: [] })).toThrow(
      /installRecorder: hosts must be a non-empty array; got \[\]/,
    );
  });

  it.each([
    { value: [""], label: "single empty string" },
    { value: ["api.anthropic.com", ""], label: "empty string mixed with valid host" },
    { value: ["", "api.anthropic.com"], label: "empty string at head" },
    { value: [null], label: "null element" },
    { value: [undefined], label: "undefined element" },
    { value: [42], label: "numeric element" },
    { value: [true], label: "boolean element" },
  ])("rejects hosts with $label", ({ value }) => {
    expect(() =>
      installRecorder({ hosts: value as unknown as string[] }),
    ).toThrow(/installRecorder: hosts\[\d+\] must be a non-empty string/);
  });

  it.each([
    ["api.anthropic.com"],
    ["api.anthropic.com", "api.openai.com"],
    ["api.anthropic.com", "api.openai.com", "api.cohere.ai"],
  ])("accepts non-empty hosts array %j", (...args) => {
    const hosts = args as string[];
    expect(() => installRecorder({ hosts })).not.toThrow();
    uninstall();
  });

  it("accepts omitted hosts (default DEFAULT_HOSTS preserved)", () => {
    expect(() => installRecorder()).not.toThrow();
  });

  it("accepts explicit-undefined hosts (default DEFAULT_HOSTS preserved)", () => {
    expect(() => installRecorder({ hosts: undefined })).not.toThrow();
  });
});

describe("installReplayer — hosts validation (issue #26)", () => {
  it("rejects empty hosts array", () => {
    expect(() => installReplayer({ hosts: [] })).toThrow(
      /installReplayer: hosts must be a non-empty array; got \[\]/,
    );
  });

  it.each([
    { value: [""], label: "single empty string" },
    { value: ["api.anthropic.com", ""], label: "empty string mixed with valid host" },
    { value: [null], label: "null element" },
    { value: [42], label: "numeric element" },
  ])("rejects hosts with $label", ({ value }) => {
    expect(() =>
      installReplayer({ hosts: value as unknown as string[] }),
    ).toThrow(/installReplayer: hosts\[\d+\] must be a non-empty string/);
  });

  it.each([
    ["api.anthropic.com"],
    ["api.anthropic.com", "api.openai.com"],
  ])("accepts non-empty hosts array %j", (...args) => {
    const hosts = args as string[];
    expect(() => installReplayer({ hosts })).not.toThrow();
    uninstall();
  });

  it("accepts omitted hosts (default DEFAULT_HOSTS preserved)", () => {
    expect(() => installReplayer()).not.toThrow();
  });
});

describe("install hosts validation — fails before interceptor takes effect", () => {
  // Pin the ordering: if validation drifted *after* the originalFetch capture,
  // the global fetch could be left in a broken state on rejection. The
  // installation must be all-or-nothing.
  it("does not capture originalFetch when hosts:[] is rejected", () => {
    const before = globalThis.fetch;
    expect(() => installRecorder({ hosts: [] })).toThrow();
    expect(globalThis.fetch).toBe(before);
  });

  it("does not capture originalFetch when hosts contains an empty string", () => {
    const before = globalThis.fetch;
    expect(() => installReplayer({ hosts: ["api.anthropic.com", ""] })).toThrow();
    expect(globalThis.fetch).toBe(before);
  });
});
