/**
 * The leak scanner reads a string field as what it says, not as it is escaped (#183).
 *
 * `assertNoLeakedSecrets` ran its patterns over `JSON.stringify(view)`. A
 * response body, an SSE frame and a raw request body are strings, so inside
 * them every `"` serialised as `\"` and every newline as `\n`:
 *
 * - `{"access_token":"<opaque>"}` became `access_token\":\"<opaque>`, and the
 *   `key=` family allows only an optional quote before the `:`;
 * - a newline before `sk-` became `\nsk-`, where the leading `\b` never fires.
 *
 * An upstream that echoed a token was written to the cassette, and the CI
 * rescan of committed cassettes reported it clean. Every row here passed on
 * `main`. The controls are the shapes that were already refused, and the allow
 * rows are ordinary traffic that has to stay accepted.
 *
 * #223 is the same bug one layer down: a string of several JSON lines (a
 * FormData body as the recorder stores it, an NDJSON body) is not JSON as a
 * whole, so it was never parsed, and a FormData record `["s", name, value]` puts
 * `","` between the name and the value, which the `key=` family never matches.
 */
import { describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";

const HEX32 = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OPAQUE32 = "Xk92mNq7ZbT4wLp1RvY8sJd3HgFc6EuA";
const SKANT = "sk-ant-api03-" + "Ab3dEfGh1jKlMn0pQrStUvWxYz012345678";
// Built from code points so no escape in this file is doing the work.
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const BACKSLASH = String.fromCharCode(92);

function base(request: Partial<CassetteV1["request"]>, response: CassetteV1["response"]): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "abc",
    request: { method: "POST", url: "https://x/y", headers: {}, body: null, ...request },
    response,
    recorded_at: "2026-05-15T00:00:00Z",
  };
}

const text = (body: string): CassetteV1["response"] => ({
  kind: "non_streaming",
  status: 200,
  headers: {},
  body,
});
const sse = (...frames: string[]): CassetteV1["response"] => ({
  kind: "sse",
  status: 200,
  headers: {},
  frames,
});

/** A request body as the recorder stores a FormData body: one JSON record per entry. */
const form = (...records: string[][]): Partial<CassetteV1["request"]> => ({
  body: records.map((r) => JSON.stringify(r)).join(NL),
  bodyEncoding: "raw",
});
const ndjson = (...docs: object[]): string => docs.map((d) => JSON.stringify(d)).join(NL);

const REFUSE: Array<[string, CassetteV1, string]> = [
  ["response JSON body {api_key}", base({}, text(JSON.stringify({ api_key: HEX32 }))), "the response"],
  [
    "response JSON body {access_token} (OAuth)",
    base({}, text(JSON.stringify({ access_token: OPAQUE32 }))),
    "the response",
  ],
  [
    "response JSON nested two levels {data:{auth_token}}",
    base({}, text(JSON.stringify({ data: { auth_token: OPAQUE32 } }))),
    "the response",
  ],
  [
    "SSE frame data {api_key}",
    base({}, sse(`data: ${JSON.stringify({ api_key: HEX32 })}${NL}${NL}`)),
    "the response",
  ],
  [
    "SSE frame JSON text with an escaped newline before sk-ant",
    base({}, sse(`data: {"text":"line1${BACKSLASH}n${SKANT}"}${NL}${NL}`)),
    "the response",
  ],
  [
    "raw request body api_key=\"<hex>\"",
    base({ body: `api_key="${HEX32}"`, bodyEncoding: "raw" }, text("ok")),
    "the request body",
  ],
  ["response text, a newline then sk-ant", base({}, text(`key:${NL}${SKANT}`)), "the response"],
  ["response text, a tab then Bearer", base({}, text(`auth:${TAB}Bearer ${OPAQUE32}`)), "the response"],
  // #223: a FormData body is stored as one JSON record per entry, joined with a
  // newline, and an NDJSON body is one JSON document per line.
  ["FormData body, one field api_key", base(form(["s", "api_key", HEX32]), text("ok")), "the request body"],
  [
    "FormData body, two fields, access_token second",
    base(form(["s", "grant_type", "client_credentials"], ["s", "access_token", OPAQUE32]), text("ok")),
    "the request body",
  ],
  [
    "FormData body, two fields, JSON {access_token} in a value",
    base(form(["s", "model", "claude"], ["s", "payload", JSON.stringify({ access_token: OPAQUE32 })]), text("ok")),
    "the request body",
  ],
  [
    "FormData body, two fields, a newline then sk-ant in a value",
    base(form(["s", "model", "claude"], ["s", "note", `line one${NL}${SKANT}`]), text("ok")),
    "the request body",
  ],
  [
    "FormData body, a file field named api_key",
    base(form(["s", "model", "claude"], ["f", "api_key", "k.txt", "text/plain", HEX32]), text("ok")),
    "the request body",
  ],
  [
    "NDJSON body, two lines, a newline then sk-ant in the second",
    base({ body: ndjson({ content: "hi" }, { content: `x${NL}${SKANT}` }), bodyEncoding: "raw" }, text("ok")),
    "the request body",
  ],
  [
    "NDJSON body, two lines, JSON {access_token} in the second",
    base(
      { body: ndjson({ content: "hi" }, { content: JSON.stringify({ access_token: OPAQUE32 }) }), bodyEncoding: "raw" },
      text("ok"),
    ),
    "the request body",
  ],
  [
    "NDJSON body, an unescaped {api_key} line (control: refused before #223 too)",
    base({ body: ndjson({ id: 1 }, { api_key: HEX32 }), bodyEncoding: "raw" }, text("ok")),
    "the request body",
  ],
  [
    "NDJSON response body, CRLF lines, JSON {api_key} in the second line's text",
    base({}, text(`${JSON.stringify({ id: 1 })}${CR}${NL}${JSON.stringify({ text: JSON.stringify({ api_key: HEX32 }) })}`)),
    "the response",
  ],
];

const ALLOW: Array<[string, CassetteV1]> = [
  ["an ordinary JSON response", base({}, text(JSON.stringify({ id: "msg_01", model: "claude-haiku-4-5" })))],
  [
    "an SSE stream of text deltas",
    base(
      {},
      sse(
        `event: content_block_delta${NL}data: {"type":"content_block_delta","delta":{"text":"the key: value"}}${NL}${NL}`,
      ),
    ),
  ],
  ["a JSON body with a long request id", base({}, text(JSON.stringify({ request_id: `req_${OPAQUE32}` })))],
  ["a string that only looks like JSON", base({}, text("{not json api_key"))],
  [
    "a FormData body of ordinary fields",
    base(form(["s", "model", "claude-haiku-4-5"], ["s", "request_id", `req_${OPAQUE32}`]), text("ok")),
  ],
  [
    "a FormData file field whose content is long but not a credential name",
    base(form(["s", "model", "claude"], ["f", "file", "notes.txt", "text/plain", OPAQUE32]), text("ok")),
  ],
  ["an NDJSON body of ordinary lines", base({ body: ndjson({ id: "msg_01" }, { id: `req_${OPAQUE32}` }), bodyEncoding: "raw" }, text("ok"))],
];

describe("escaped string fields are scanned as what they say (#183)", () => {
  it.each(REFUSE)("refuses: %s", (_name, cassette, where) => {
    expect(() => assertNoLeakedSecrets(cassette)).toThrow(new RegExp(`in ${where}`));
  });

  it.each(ALLOW)("allows: %s", (_name, cassette) => {
    expect(() => assertNoLeakedSecrets(cassette)).not.toThrow();
  });
});
