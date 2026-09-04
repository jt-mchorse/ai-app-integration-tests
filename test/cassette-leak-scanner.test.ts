/**
 * The leak scanner's population, both arms (#113, D-004).
 *
 * `assertNoLeakedSecrets` is the belt-and-suspenders half of D-004: header
 * redaction runs first, and this refuses to write a cassette that still looks
 * like it carries a credential. Its docstring listed `key=` among the scanned
 * prefixes and no pattern implemented it, so five credential shapes were
 * committed verbatim:
 *
 *   ?key=<32 hex>            ?api-key=<32 hex>        ?access_token=<opaque>
 *   {"api_key": "<32 hex>"}  an echoed body carrying api-key=<32 hex>
 *
 * The URL rows are not hypothetical the way the "echoed error body" rationale
 * behind the `AIza` / `Basic` patterns is. `normalizeUrl` strips the fragment
 * (#56) and userinfo (#64) and **preserves the query string**, so a request to
 * an API that authenticates by query parameter writes its key into the
 * committed cassette every single time. Azure OpenAI, Google, OAuth and Azure
 * SAS all do that.
 *
 * **Both arms are load-bearing.** A leak guard is worth nothing if it refuses
 * a `model=` name or a base64 image chunk, because the first thing anyone does
 * with a noisy security gate is switch it off. The negative rows below are the
 * half that keeps the pattern anchored on names that mean "credential" rather
 * than on length alone.
 */

import { describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";

const HEX32 = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OPAQUE32 = "Xk92mNq7ZbT4wLp1RvY8sJd3HgFc6EuA";
const GOOGLE = "AIzaSyD-1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P";
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function cassetteWithUrl(url: string): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "abc",
    request: { method: "GET", url, headers: {}, body: null },
    response: { kind: "non_streaming", status: 200, headers: {}, body: "ok" },
    recorded_at: "2026-05-15T00:00:00Z",
  };
}

function cassetteWithBody(body: unknown): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "abc",
    request: { method: "POST", url: "https://x/y", headers: {}, body },
    response: { kind: "non_streaming", status: 200, headers: {}, body: "ok" },
    recorded_at: "2026-05-15T00:00:00Z",
  };
}

function cassetteWithResponseBody(body: string): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "abc",
    request: { method: "GET", url: "https://x/y", headers: {}, body: null },
    response: { kind: "non_streaming", status: 400, headers: {}, body },
    recorded_at: "2026-05-15T00:00:00Z",
  };
}

/** Rows the scanner MUST refuse. `#113` marks the ones it used to pass. */
const MUST_REFUSE: Array<[string, CassetteV1]> = [
  ["#113 query ?key=<32 hex>", cassetteWithUrl(`https://api.example.com/v1?key=${HEX32}`)],
  [
    "#113 query ?api-key=<32 hex> (Azure OpenAI)",
    cassetteWithUrl(`https://x.openai.azure.com/v1/chat?api-key=${HEX32}`),
  ],
  [
    "#113 query ?access_token=<opaque> (OAuth)",
    cassetteWithUrl(`https://api.example.com/v1?access_token=${OPAQUE32}`),
  ],
  ["#113 body {\"api_key\": <32 hex>}", cassetteWithBody({ api_key: HEX32 })],
  [
    "#113 echoed error body carrying api-key=<32 hex>",
    cassetteWithResponseBody(`{"error":"invalid api-key=${HEX32}"}`),
  ],
  // The five that already worked, kept here so a pattern edit that narrows the
  // set shows up as a red row rather than as silence.
  ["existing sk- token", cassetteWithResponseBody(`echo "sk-${OPAQUE32}abcdefgh"`)],
  ["existing Bearer token", cassetteWithBody({ h: `Bearer ${OPAQUE32}` })],
  ["existing AIza key", cassetteWithResponseBody(`{"error":"API key not valid: ${GOOGLE}"}`)],
  ["existing Basic credential", cassetteWithBody({ h: "Basic YWxhZGRpbjpvcGVuc2VzYW1l" })],
  ["existing URL userinfo", cassetteWithBody({ dsn: "https://u:p@host/db" })],
];

/** Rows the scanner MUST NOT refuse. Every one is ordinary recorded traffic. */
const MUST_ALLOW: Array<[string, CassetteV1]> = [
  [
    "a model name in the query string",
    cassetteWithUrl("https://api.anthropic.com/v1/messages?model=claude-opus-4-6-20260101"),
  ],
  ["a long request id", cassetteWithBody({ request_id: "req_011CQ7xYzAbCdEfGhIjKlMnOpQrStUvWxYz" })],
  ["a base64 image chunk", cassetteWithBody({ image: PNG_B64 })],
  [
    "a long value under a field whose name merely ENDS in 'key'",
    cassetteWithBody({ monkey: HEX32 }),
  ],
  ["prose using 'key:' in a sentence", cassetteWithBody({ description: "the key: value pattern" })],
  ["an already-redacted header", cassetteWithBody({ note: "x-api-key: [REDACTED]" })],
  ["a short id after key=", cassetteWithUrl("https://api.example.com/v1?key=abc123")],
];

describe("assertNoLeakedSecrets population", () => {
  it("the table carries both verdicts", () => {
    // A table that drifted to all-refuse or all-allow would make every case
    // below pass while proving nothing about the boundary between them.
    expect(MUST_REFUSE.length).toBeGreaterThanOrEqual(8);
    expect(MUST_ALLOW.length).toBeGreaterThanOrEqual(5);
  });

  it("at least five refuse-rows are the #113 gaps, not the pre-existing patterns", () => {
    // Without this, deleting the new pattern and keeping only the old rows
    // would leave a green suite that tests nothing this issue is about.
    const gaps = MUST_REFUSE.filter(([name]) => name.startsWith("#113"));
    expect(gaps.length).toBeGreaterThanOrEqual(5);
  });

  it.each(MUST_REFUSE)("refuses: %s", (_name, cassette) => {
    expect(() => assertNoLeakedSecrets(cassette)).toThrow(/unredacted secret/);
  });

  it.each(MUST_ALLOW)("allows: %s", (_name, cassette) => {
    expect(() => assertNoLeakedSecrets(cassette)).not.toThrow();
  });
});

describe("the docstring's promise", () => {
  it("a key= prefix is actually scanned, not merely documented", () => {
    // The defect in one line: the docstring named `key=` as a scanned prefix
    // for a long time and no pattern implemented it.
    expect(() => assertNoLeakedSecrets(cassetteWithUrl(`https://h/v1?key=${HEX32}`))).toThrow();
  });

  it("the scan covers the URL and the body, not only header values", () => {
    // The docstring also said "in a header VALUE". The scan runs over the whole
    // serialized cassette, and the URL and body are exactly where a credential
    // escapes header redaction.
    expect(() => assertNoLeakedSecrets(cassetteWithUrl(`https://h/v1?api-key=${HEX32}`))).toThrow();
    expect(() => assertNoLeakedSecrets(cassetteWithBody({ api_key: HEX32 }))).toThrow();
  });
});
