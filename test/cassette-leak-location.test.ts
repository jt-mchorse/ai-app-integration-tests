/**
 * The leak scanner says where the secret is, and advice that can remove it (#151).
 *
 * Every refusal said "Update redactHeaders() and re-record". `redactHeaders`
 * strips header NAMES from a fixed list callers cannot extend, and #113's
 * pattern exists for the URL and body, which are recorded as-is: a recording
 * of `...?key=AIza...` was refused, told to update redactHeaders, and refused
 * identically on the next attempt.
 */
import { describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";

const KEY = "AIza" + "x".repeat(35);
const base = (): CassetteV1 => ({
  schema_version: "1",
  request_hash: "abc",
  request: { method: "POST", url: "https://x/y", headers: {}, body: null },
  response: { kind: "non_streaming", status: 200, headers: {}, body: "ok" },
  recorded_at: "2026-05-15T00:00:00Z",
});

function refusal(c: CassetteV1): string {
  try {
    assertNoLeakedSecrets(c);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("leak-scanner location and advice (#151)", () => {
  it("a key in the URL query string names the URL and says to use a header", () => {
    const c = base();
    c.request.url = `https://generativelanguage.googleapis.com/v1/models?key=${KEY}`;
    const msg = refusal(c);
    expect(msg).toContain("in the request URL");
    expect(msg).toContain("send the credential as a header");
    expect(msg).not.toContain("Update redactHeaders()");
  });

  it("a key in the request body names the body", () => {
    const c = base();
    c.request.body = { access_token: "t".repeat(30) };
    expect(refusal(c)).toContain("in the request body");
  });

  it("a key under an unlisted header names the headers and the list", () => {
    const c = base();
    c.request.headers = { "x-custom-auth": `Bearer ${"t".repeat(40)}` };
    const msg = refusal(c);
    expect(msg).toContain("in the request headers");
    expect(msg).toContain("SENSITIVE_HEADER_NAMES");
  });

  it("a key echoed by the server names the response", () => {
    const c = base();
    c.response = { kind: "non_streaming", status: 400, headers: {}, body: `bad key ${KEY}` };
    expect(refusal(c)).toContain("in the response");
  });

  it("a clean cassette is still accepted", () => {
    expect(() => assertNoLeakedSecrets(base())).not.toThrow();
  });
});
