import { describe, it, expect } from "vitest";

import {
  assertNoLeakedSecrets,
  canonicalize,
  hashRequest,
  normalizeUrl,
  redactHeaders,
  type CassetteV1,
} from "../src/cassette.js";

describe("canonicalize", () => {
  it("recursively sorts object keys", () => {
    const input = { z: 1, a: { y: 2, b: 3 } };
    expect(JSON.stringify(canonicalize(input))).toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  it("preserves array order", () => {
    const input = [{ b: 2, a: 1 }, { d: 4, c: 3 }];
    expect(JSON.stringify(canonicalize(input))).toBe('[{"a":1,"b":2},{"c":3,"d":4}]');
  });

  it("returns primitives unchanged", () => {
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize("x")).toBe("x");
    expect(canonicalize(null)).toBe(null);
  });
});

describe("normalizeUrl", () => {
  it("sorts query params", () => {
    expect(normalizeUrl("https://api.anthropic.com/v1/messages?b=2&a=1")).toBe(
      "https://api.anthropic.com/v1/messages?a=1&b=2",
    );
  });

  it("preserves path and host", () => {
    expect(normalizeUrl("https://api.anthropic.com/v1/messages")).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("preserves repeated query params with the same key", () => {
    const u = normalizeUrl("https://x/y?tag=a&tag=b");
    expect(u).toContain("tag=a");
    expect(u).toContain("tag=b");
  });

  it("canonicalizes repeated same-key params to a stable order regardless of input order (#42)", () => {
    // Both orderings must normalize to the same string, not just contain the
    // same values — otherwise reordering causes a replay miss.
    expect(normalizeUrl("https://x/y?tag=b&tag=a")).toBe(normalizeUrl("https://x/y?tag=a&tag=b"));
    expect(normalizeUrl("https://x/y?tag=b&tag=a")).toBe("https://x/y?tag=a&tag=b");
  });
});

describe("hashRequest", () => {
  it("is stable across body-key reordering", () => {
    const a = hashRequest({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: canonicalize({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] }),
    });
    const b = hashRequest({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: canonicalize({ messages: [{ role: "user", content: "hi" }], model: "claude-haiku-4-5" }),
    });
    expect(a).toBe(b);
  });

  it("changes when the message content changes", () => {
    const a = hashRequest({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: { model: "x", messages: [{ role: "user", content: "hello" }] },
    });
    const b = hashRequest({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: { model: "x", messages: [{ role: "user", content: "world" }] },
    });
    expect(a).not.toBe(b);
  });

  it("changes when the URL path changes", () => {
    const a = hashRequest({ method: "GET", url: "https://x/a", headers: {}, body: null });
    const b = hashRequest({ method: "GET", url: "https://x/b", headers: {}, body: null });
    expect(a).not.toBe(b);
  });

  it("ignores headers (header values vary across runs)", () => {
    const a = hashRequest({ method: "GET", url: "https://x/a", headers: { x: "1" }, body: null });
    const b = hashRequest({ method: "GET", url: "https://x/a", headers: { y: "2" }, body: null });
    expect(a).toBe(b);
  });

  it("is stable across repeated same-key query-param reordering (#42)", () => {
    // The replay-miss the bug caused: record with one ordering, replay with the
    // other. Both go through normalizeUrl first (as the recorder does), so the
    // hashes must match or replay throws MissingCassetteError (D-005).
    const a = hashRequest({
      method: "GET",
      url: normalizeUrl("https://x/y?tag=a&tag=b"),
      headers: {},
      body: null,
    });
    const b = hashRequest({
      method: "GET",
      url: normalizeUrl("https://x/y?tag=b&tag=a"),
      headers: {},
      body: null,
    });
    expect(a).toBe(b);
  });
});

describe("redactHeaders", () => {
  it("redacts x-api-key", () => {
    expect(redactHeaders({ "x-api-key": "sk-ant-abcdef" })["x-api-key"]).toBe("[REDACTED]");
  });

  it("redacts authorization", () => {
    expect(redactHeaders({ Authorization: "Bearer secret" }).authorization).toBe("[REDACTED]");
  });

  it("preserves non-sensitive headers", () => {
    const r = redactHeaders({ "content-type": "application/json", "x-custom": "ok" });
    expect(r["content-type"]).toBe("application/json");
    expect(r["x-custom"]).toBe("ok");
  });

  it("lower-cases header names and sorts the result", () => {
    const r = redactHeaders({ Foo: "1", Bar: "2", "Anthropic-API-Key": "leak" });
    const keys = Object.keys(r);
    expect(keys).toEqual(["anthropic-api-key", "bar", "foo"]);
    expect(r["anthropic-api-key"]).toBe("[REDACTED]");
  });

  it("redacts x-goog-api-key (#22)", () => {
    // Mixed-case input also re-proves the case-insensitive branch in the
    // same assertion path.
    const r = redactHeaders({ "X-Goog-Api-Key": "AIzaSy_some_key_value" });
    expect(r["x-goog-api-key"]).toBe("[REDACTED]");
  });
});

describe("assertNoLeakedSecrets", () => {
  function baseCassette(extra: Partial<CassetteV1>): CassetteV1 {
    return {
      schema_version: "1",
      request_hash: "abc",
      request: { method: "GET", url: "https://x/y", headers: {}, body: null },
      response: { kind: "non_streaming", status: 200, headers: {}, body: "ok" },
      recorded_at: "2026-05-15T00:00:00Z",
      ...extra,
    };
  }

  it("passes a redacted cassette", () => {
    const c = baseCassette({
      request: { method: "POST", url: "https://x/y", headers: { "x-api-key": "[REDACTED]" }, body: { model: "x" } },
    });
    expect(() => assertNoLeakedSecrets(c)).not.toThrow();
  });

  it("throws when a sk-ant-… token leaks anywhere in the cassette", () => {
    const c = baseCassette({
      response: {
        kind: "non_streaming",
        status: 200,
        headers: {},
        body: 'echo "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890"',
      },
    });
    expect(() => assertNoLeakedSecrets(c)).toThrow(/unredacted secret/);
  });

  it("throws when a Google API key (AIza…) leaks in the response body (#22 parity)", () => {
    // Google's 400 responses historically echo the submitted key. The
    // x-goog-api-key header is redacted (#22); the scanner must also catch
    // the same key class leaking through a non-redacted channel.
    const c = baseCassette({
      response: {
        kind: "non_streaming",
        status: 400,
        headers: {},
        body: '{"error":"API key not valid: AIzaSyD-1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P"}',
      },
    });
    expect(() => assertNoLeakedSecrets(c)).toThrow(/unredacted secret/);
  });

  it("throws when a Bearer token leaks", () => {
    const c = baseCassette({
      request: {
        method: "GET",
        url: "https://x/y",
        headers: { authorization: "Bearer abc123def456ghi789jkl012mno345" },
        body: null,
      },
    });
    expect(() => assertNoLeakedSecrets(c)).toThrow(/unredacted secret/);
  });
});
