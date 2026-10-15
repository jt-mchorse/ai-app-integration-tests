/**
 * The leak scanner reads an auth scheme name in any case (#201, D-004).
 *
 * `Bearer` and `Basic` were matched by their capitalised spelling only. A
 * scheme name is case-insensitive (RFC 9110 §11.1), and these two patterns
 * exist for the channels header redaction does not cover -- a custom auth
 * header, a request body, an echoed error, an SSE frame -- where the spelling
 * is whatever the sender chose. `bearer <token>` and `BASIC <base64>` were
 * written to the cassette, and the committed-cassette rescan, which calls the
 * same function, passed them.
 *
 * The allow rows are as load-bearing as the refuse rows: `/i` widens the
 * `Basic` pattern's prose surface from "Basic" to "basic", so ordinary
 * lowercase prose is pinned as allowed.
 */
import { describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";

const TOKEN = "Xk92mNq7ZbT4wLp1RvY8sJd3HgFc6EuA";
// base64("aladdin:opensesame"), the RFC 7617 example credential.
const BASIC_CRED = "YWxhZGRpbjpvcGVuc2VzYW1l";

function cassette(
  headers: Record<string, string>,
  body: unknown,
  response: CassetteV1["response"] = {
    kind: "non_streaming",
    status: 200,
    headers: {},
    body: "ok",
  },
): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "abc",
    request: { method: "POST", url: "https://api.example.com/v1", headers, body },
    response,
    recorded_at: "2026-10-14T00:00:00Z",
  };
}

const errorBody = (text: string): CassetteV1["response"] => ({
  kind: "non_streaming",
  status: 401,
  headers: {},
  body: JSON.stringify({ error: { message: text } }),
});

const sseFrame = (text: string): CassetteV1["response"] => ({
  kind: "sse",
  status: 200,
  headers: { "content-type": "text/event-stream" },
  frames: [`data: ${JSON.stringify({ note: text })}\n\n`],
});

const MUST_REFUSE: Array<[string, CassetteV1]> = [
  ["bearer in a custom header", cassette({ "x-upstream-auth": `bearer ${TOKEN}` }, null)],
  ["BEARER in a request body", cassette({}, { auth: `BEARER ${TOKEN}` })],
  ["bEaReR in an echoed error body", cassette({}, null, errorBody(`bad token: bEaReR ${TOKEN}`))],
  ["bearer in an SSE frame", cassette({}, null, sseFrame(`authorization: bearer ${TOKEN}`))],
  ["basic in a custom header", cassette({ "x-proxy-auth": `basic ${BASIC_CRED}` }, null)],
  ["BASIC in a request body", cassette({}, { auth: `BASIC ${BASIC_CRED}` })],
  ["basic in an echoed error body", cassette({}, null, errorBody(`bad proxy auth: basic ${BASIC_CRED}`))],
];

// Controls: the capitalised spelling was already refused and must stay so.
const CONTROLS: Array<[string, CassetteV1]> = [
  ["Bearer in a custom header", cassette({ "x-upstream-auth": `Bearer ${TOKEN}` }, null)],
  ["Basic in a request body", cassette({}, { auth: `Basic ${BASIC_CRED}` })],
];

const MUST_ALLOW: Array<[string, CassetteV1]> = [
  ["lowercase 'basic plan' prose", cassette({}, { text: "the basic plan includes 5 seats." })],
  [
    "lowercase 'basic' before ordinary words",
    cassette({}, null, errorBody("a basic understanding of authentication is assumed")),
  ],
  ["OAuth token_type bearer", cassette({}, null, errorBody('{"token_type":"bearer","expires_in":3600}'))],
  ["a bearer bond in prose", cassette({}, { text: "the bearer bond matured in 2031" })],
  ["the redacted marker", cassette({ authorization: "[REDACTED]" }, { note: "bearer [REDACTED]" })],
];

describe("assertNoLeakedSecrets: auth scheme names in any case (#201)", () => {
  it.each(MUST_REFUSE)("refuses: %s", (_name, c) => {
    expect(() => assertNoLeakedSecrets(c)).toThrow(/unredacted secret/);
  });

  it.each(CONTROLS)("still refuses: %s", (_name, c) => {
    expect(() => assertNoLeakedSecrets(c)).toThrow(/unredacted secret/);
  });

  it.each(MUST_ALLOW)("allows: %s", (_name, c) => {
    expect(() => assertNoLeakedSecrets(c)).not.toThrow();
  });

  it("names where the lowercase credential is, like the capitalised one (#151)", () => {
    expect(() =>
      assertNoLeakedSecrets(cassette({ "x-upstream-auth": `bearer ${TOKEN}` }, null)),
    ).toThrow(/in the request headers/);
  });
});
