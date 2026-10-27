/**
 * Bare `token` and `assertion` are credential names only on the form surfaces
 * (#256, regression from #253).
 *
 * #253 added bare `token` (RFC 7009/7662) and `assertion` (RFC 7521) to the
 * `key=`-family pattern, which reads every text in the cassette. An OpenAI
 * Chat Completions response with `logprobs: true` carries every output token
 * as `{"token": "<text>", ...}`, in a JSON body and in each SSE `data:` chunk,
 * and a tokenizer has single tokens of 24+ value-class characters. Every
 * NEGATIVE row below was refused on main d2eb5db, after the live call, and
 * passed with `src/cassette.ts` from before #253.
 *
 * The token texts are real single tokens, not made-up strings. They were taken
 * from tiktoken 0.14 by decoding every id and keeping the UTF-8 texts that
 * match the pattern's value class `[A-Za-z0-9_\-.+/=]{24,}`: cl100k_base has
 * 71, o200k_base 45. The rows cover each character class in that set.
 *
 * The rule now: bare `token` and `assertion` are refused in the request URL,
 * a request header, and a form body (form-urlencoded, multipart, a FormData
 * record). Compound names (`access_token`, `refresh_token`,
 * `client_assertion`, ...) are refused everywhere, as before.
 *
 * #258 (regression from #257): a form body was a form only in the canonical
 * `URLSearchParams.toString()` shape. A trailing `&`, a raw space, a trailing
 * newline, a BOM or a bare flag lost the rule, and the token went live and was
 * written. `PARSED_FORMS` is built from what URLSearchParams, undici's
 * `Response.formData()` and Python's `parse_qsl` read as a `token` /
 * `assertion` field; every row but the canonical one and `a=&token=` was
 * written on main 6c289a7.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";
import { CassetteStore, createRecorderFetch } from "../src/index.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOSTS = new Set(["api.openai.com", "auth.example.com"]);
const CHAT_URL = "https://api.openai.com/v1/chat/completions";
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const BOM = String.fromCharCode(0xfeff);
// No prefix of its own, so only the name marks it. Built from parts so this
// file is not a leak.
const FAKE_OPAQUE = ["fake", "opaque", "z".repeat(24)].join("");

// [tokenizer, id, text]: real single tokens, from tiktoken.
const TOKENS: Array<readonly [string, number, string]> = [
  ["cl100k_base", 1434, "-".repeat(32)],
  ["cl100k_base", 3134, "=".repeat(32)],
  ["cl100k_base", 17924, "_".repeat(32)],
  ["cl100k_base", 3985, "/".repeat(32)],
  ["cl100k_base", 16971, ".".repeat(32)],
  ["cl100k_base", 89255, "+".repeat(32)],
  ["cl100k_base", 26972, "-".repeat(74) + LF],
  ["cl100k_base", 63570, ".translatesAutoresizingMaskIntoConstraints"],
  ["cl100k_base", 51926, "ValidateAntiForgeryToken"],
  ["cl100k_base", 68612, "abcdefghijklmnopqrstuvwxyz"],
  ["o200k_base", 104856, ".".repeat(24)],
  ["o200k_base", 6288, "=".repeat(32)],
];

/** One logprobs entry for `token`, with the token in its own top-1 list too. */
function logprob(token: string) {
  const bytes = [...Buffer.from(token, "utf8")];
  return { token, logprob: -0.0001, bytes, top_logprobs: [{ token, logprob: -0.0001, bytes }] };
}

/** A non-streaming Chat Completions body with `logprobs: true`. */
function chatBody(token: string, content = token): string {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        logprobs: { content: [logprob(token)] },
        finish_reason: "stop",
      },
    ],
  });
}

/** The same token as streamed: one chunk frame, then `[DONE]`. */
function chatFrames(token: string): string[] {
  const chunk = JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: { content: token }, logprobs: { content: [logprob(token)] }, finish_reason: null }],
  });
  return [`data: ${chunk}\n\n`, "data: [DONE]\n\n"];
}

const REQUEST_BODY = { model: "gpt-4o-mini", logprobs: true, top_logprobs: 1, messages: [] };

function cassette(over: {
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  response?: CassetteV1["response"];
}): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "0".repeat(32),
    request: {
      method: "POST",
      url: over.url ?? CHAT_URL,
      headers: over.headers ?? { "content-type": "application/json" },
      body: over.body === undefined ? REQUEST_BODY : over.body,
    },
    response: over.response ?? { kind: "non_streaming", status: 200, headers: {}, body: "{}" },
    recorded_at: "2026-10-26T00:00:00Z",
  };
}

const jsonResponse = (body: string): CassetteV1 =>
  cassette({ response: { kind: "non_streaming", status: 200, headers: {}, body } });
const sseResponse = (frames: string[]): CassetteV1 => cassette({ response: { kind: "sse", status: 200, headers: {}, frames } });

// Every row was refused on main d2eb5db and records now.
const RECORDS: Array<readonly [string, CassetteV1]> = [
  ...TOKENS.flatMap(([enc, id, text]): Array<readonly [string, CassetteV1]> => [
    [`${enc} ${id} in a JSON body`, jsonResponse(chatBody(text))],
    [`${enc} ${id} in an SSE frame`, sseResponse(chatFrames(text))],
  ]),
  // A `%` in the same body makes `scanTexts` read it as form-urlencoded too
  // (#237); its decoded pairs must not count as a form surface, or the token
  // is refused through them.
  ["cl100k_base 3134 beside a % in the content", jsonResponse(chatBody("=".repeat(32), `100%\n${"=".repeat(32)}`))],
  ["eval JSON assertion in the response", jsonResponse('{"assertion":"response_mentions_refund_policy"}')],
  ["eval JSON lastAssertion in the response", jsonResponse('{"lastAssertion":"response_mentions_refund_policy"}')],
  ["eval JSON assertion in the request body", cassette({ body: { assertion: "response_mentions_refund_policy" } })],
];

// Every row is refused, before and after.
const REFUSES: Array<readonly [string, CassetteV1]> = [
  [
    "RFC 7009 token= in a form body",
    cassette({
      url: "https://auth.example.com/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${FAKE_OPAQUE}&token_type_hint=refresh_token`,
    }),
  ],
  [
    "token= in a percent-encoded form body",
    cassette({
      url: "https://auth.example.com/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(`${FAKE_OPAQUE}/x`)}`,
    }),
  ],
  ["token= in a query string", cassette({ url: `https://auth.example.com/introspect?token=${FAKE_OPAQUE}`, body: null })],
  [
    "assertion= in a form body",
    cassette({ body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${FAKE_OPAQUE}` }),
  ],
  ["clientAssertion= in a query string", cassette({ url: `https://auth.example.com/t?clientAssertion=${FAKE_OPAQUE}` })],
  ["an x-vault-token request header", cassette({ headers: { "x-vault-token": FAKE_OPAQUE } })],
  ["a FormData field named token", cassette({ body: [["s", "token", FAKE_OPAQUE]] })],
  ["access_token in a JSON response", jsonResponse(JSON.stringify({ access_token: FAKE_OPAQUE }))],
  ["refresh_token in a JSON response", jsonResponse(JSON.stringify({ refresh_token: FAKE_OPAQUE }))],
  ["access_token in an SSE frame", sseResponse([`data: ${JSON.stringify({ access_token: FAKE_OPAQUE })}\n\n`])],
  ["client_assertion in a JSON request body", cassette({ body: { client_assertion: FAKE_OPAQUE } })],
];

// [label, body, field]: a form body each of URLSearchParams, undici's
// `formData()` and Python's `parse_qsl` reads as `field` = FAKE_OPAQUE (or
// FAKE_OPAQUE with the whitespace around it). Checked for the first two below.
const REVOKE_URL = "https://auth.example.com/oauth/revoke";
const JWT_GRANT = "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer";
const PARSED_FORMS: Array<readonly [string, string, "token" | "assertion"]> = [
  ["canonical", `token=${FAKE_OPAQUE}&token_type_hint=access_token`, "token"],
  ["a trailing &", `token=${FAKE_OPAQUE}&token_type_hint=access_token&`, "token"],
  ["a leading &", `&token=${FAKE_OPAQUE}`, "token"],
  ["an empty segment", `a=b&&token=${FAKE_OPAQUE}`, "token"],
  ["a raw space in another value", `client_id=my app&token=${FAKE_OPAQUE}`, "token"],
  ["a raw space after the token", `token=${FAKE_OPAQUE}&scope=read write`, "token"],
  ["a tab in a value", `client_id=my${TAB}app&token=${FAKE_OPAQUE}`, "token"],
  ["a trailing LF", `token=${FAKE_OPAQUE}&token_type_hint=access_token${LF}`, "token"],
  ["a trailing CRLF", `token=${FAKE_OPAQUE}&token_type_hint=access_token${CR}${LF}`, "token"],
  ["a leading LF", `${LF}token=${FAKE_OPAQUE}`, "token"],
  ["a leading BOM", `${BOM}token=${FAKE_OPAQUE}&token_type_hint=access_token`, "token"],
  ["a BOM before a later pair", `a=b&${BOM}token=${FAKE_OPAQUE}`, "token"],
  ["a bare flag first", `verbose&token=${FAKE_OPAQUE}`, "token"],
  ["a bare flag last", `token=${FAKE_OPAQUE}&verbose`, "token"],
  ["an empty name", `=x&token=${FAKE_OPAQUE}`, "token"],
  ["an empty value", `a=&token=${FAKE_OPAQUE}`, "token"],
  ["JSON with a space in a value", `state={"x": 1}&token=${FAKE_OPAQUE}`, "token"],
  ["assertion= with a trailing &", `${JWT_GRANT}&assertion=${FAKE_OPAQUE}&`, "assertion"],
  ["assertion= with a trailing LF", `${JWT_GRANT}&assertion=${FAKE_OPAQUE}${LF}`, "assertion"],
  ["assertion= with a raw space", `scope=a b&assertion=${FAKE_OPAQUE}`, "assertion"],
  ["assertion= after a bare flag", `verbose&assertion=${FAKE_OPAQUE}`, "assertion"],
  ["assertion= after a BOM", `${BOM}assertion=${FAKE_OPAQUE}`, "assertion"],
];

// A form only through its recorded content-type (#258): a line break inside a
// value ends the shape on purpose, so prose that starts with `x=1` and has a
// `token:` on a later line is not read as a form.
const LF_IN_VALUE = `note=line1${LF}line2&token=${FAKE_OPAQUE}`;

const formCassette = (body: string, headers: Record<string, string> = {}): CassetteV1 =>
  cassette({ url: REVOKE_URL, headers, body });

const DECLARED_FORMS: Array<readonly [string, CassetteV1]> = [
  [
    "a request body declared form-urlencoded, LF inside a value",
    formCassette(LF_IN_VALUE, { "content-type": "application/x-www-form-urlencoded" }),
  ],
  [
    "the same with Content-Type spelled in mixed case and a charset",
    formCassette(LF_IN_VALUE, { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }),
  ],
  [
    "a response declared form-urlencoded, LF inside a value",
    cassette({
      response: {
        kind: "non_streaming",
        status: 200,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: LF_IN_VALUE,
      },
    }),
  ],
];

// Records before and after #258: the looser form shape must not read a JSON
// text, an SSE frame, or what `URLSearchParams` decodes out of one, as a form.
const FORM_SHAPE_RECORDS: Array<readonly [string, CassetteV1]> = [
  ["content 'a = b c 100%' beside a logprobs token", jsonResponse(chatBody("=".repeat(32), "a = b c 100%"))],
  ["content 'a=b c 100%' beside a logprobs token", jsonResponse(chatBody("=".repeat(32), "a=b c 100%"))],
  ["content 'x=1 & y=2 50%' beside a logprobs token", jsonResponse(chatBody("-".repeat(32), "x=1 & y=2 50%"))],
  [
    "a pretty-printed logprobs body",
    jsonResponse(JSON.stringify(JSON.parse(chatBody("-".repeat(32))), null, 2)),
  ],
  [
    "an SSE event with event: and id: lines",
    sseResponse([`event: chunk${LF}id: 1${LF}${chatFrames("=".repeat(32))[0]}`, "data: [DONE]\n\n"]),
  ],
  ["an SSE frame with content 'a=b c 100%'", sseResponse(chatFrames("=".repeat(32)).map((f) => f.replace('"content":"', '"content":"a=b c 100% ')))],
  ["NDJSON logprobs lines", jsonResponse(`${chatBody("-".repeat(32), "x")}${LF}${chatBody("=".repeat(32), "a=b %")}`)],
  [
    "content 'x=1' then a 'token:' on the next line",
    jsonResponse(chatBody("x", `x=1${LF}next token: ValidateAntiForgeryToken`)),
  ],
];

describe("a logprobs or eval response records (#256)", () => {
  it.each(RECORDS)("%s", (_label, c) => {
    expect(() => assertNoLeakedSecrets(c)).not.toThrow();
  });
});

describe("controls: bare token on a form surface, and compound names anywhere, are refused", () => {
  it.each(REFUSES)("%s", (_label, c) => {
    expect(() => assertNoLeakedSecrets(c)).toThrow("unredacted secret");
  });

  it("names the request body for a form-body token=", () => {
    expect(() => assertNoLeakedSecrets(REFUSES[0][1])).toThrow("in the request body");
  });
});

describe("a form body in any shape a form parser reads is refused (#258)", () => {
  it.each(PARSED_FORMS)("%s: the parsers read the field", async (_label, body, field) => {
    const read = (pairs: Iterable<[string, FormDataEntryValue | string]>) =>
      [...pairs].filter(([, v]) => String(v).trim() === FAKE_OPAQUE).map(([k]) => k.trim());
    const fd = await new Response(body, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }).formData();
    expect(read(new URLSearchParams(body))).toEqual([field]);
    expect(read(fd)).toEqual([field]);
  });

  // No content-type header: the body's shape alone makes it a form.
  it.each(PARSED_FORMS)("%s: refused by its shape, in the request body", (_label, body) => {
    expect(() => assertNoLeakedSecrets(formCassette(body))).toThrow(/unredacted secret.* in the request body/);
  });

  it.each(DECLARED_FORMS)("%s", (_label, c) => {
    expect(() => assertNoLeakedSecrets(c)).toThrow("unredacted secret");
  });

  it("names the response for a response declared form-urlencoded", () => {
    expect(() => assertNoLeakedSecrets(DECLARED_FORMS[2][1])).toThrow("in the response");
  });
});

describe("the parsers' form shape still does not read JSON or SSE as a form (#258)", () => {
  it.each(FORM_SHAPE_RECORDS)("%s", (_label, c) => {
    expect(() => assertNoLeakedSecrets(c)).not.toThrow();
  });
});

describe("through the recorder", () => {
  let dir: string;
  let calls: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-logprobs-"));
    calls = 0;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function recorder(body: string, contentType: string) {
    const upstream = (async () => {
      calls += 1;
      return new Response(body, { status: 200, headers: { "content-type": contentType } });
    }) as typeof fetch;
    return createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
  }

  const written = async () => (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const chatInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(REQUEST_BODY) };

  it("a logprobs JSON response is written", async () => {
    await recorder(chatBody("-".repeat(32)), "application/json")(CHAT_URL, chatInit);
    expect(calls).toBe(1);
    expect(await written()).toHaveLength(1);
  });

  it("a streamed logprobs response is written", async () => {
    const res = await recorder(chatFrames("=".repeat(32)).join(""), "text/event-stream")(CHAT_URL, chatInit);
    await res.text();
    expect(calls).toBe(1);
    expect(await written()).toHaveLength(1);
  });

  it("an RFC 7009 revocation form body is refused before the live call", async () => {
    const init = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${FAKE_OPAQUE}&token_type_hint=access_token`,
    };
    await expect(recorder("", "text/plain")("https://auth.example.com/oauth/revoke", init)).rejects.toThrow(
      "unredacted secret",
    );
    expect(calls).toBe(0);
    expect(await written()).toHaveLength(0);
  });

  it("a FormData field named token is refused before the live call", async () => {
    const fd = new FormData();
    fd.append("token", FAKE_OPAQUE);
    const init = { method: "POST", body: fd };
    await expect(recorder("", "text/plain")("https://auth.example.com/oauth/revoke", init)).rejects.toThrow(
      "unredacted secret",
    );
    expect(calls).toBe(0);
  });

  // No content-type header, so the recorded request carries none and only the
  // body's shape can refuse it.
  it.each(PARSED_FORMS)("%s: refused before the live call, nothing written", async (_label, body) => {
    await expect(recorder("", "text/plain")(REVOKE_URL, { method: "POST", body })).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
    expect(await written()).toHaveLength(0);
  });

  it("a declared form body with a line break inside a value is refused before the live call", async () => {
    const init = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: LF_IN_VALUE };
    await expect(recorder("", "text/plain")(REVOKE_URL, init)).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
    expect(await written()).toHaveLength(0);
  });

  it("the committed-cassette rescan passes every logprobs row and refuses every control", async () => {
    const fixtures = path.join(dir, "fixtures");
    await fs.mkdir(fixtures);
    // Indexed: two labels differing only in case collide on macOS.
    const name = (kind: string, i: number, label: string) => `${kind}-${i}-${label.replace(/\W+/g, "-")}.json`;
    const records = [...RECORDS, ...FORM_SHAPE_RECORDS];
    const refuses = [
      ...REFUSES,
      ...PARSED_FORMS.map(([label, body]): readonly [string, CassetteV1] => [label, formCassette(body)]),
      ...DECLARED_FORMS,
    ];
    const clean = records.map(([label], i) => name("clean", i, label));
    const leaks = refuses.map(([label], i) => name("leak", i, label));
    for (const [i, [, c]] of records.entries()) await fs.writeFile(path.join(fixtures, clean[i]), JSON.stringify(c));
    for (const [i, [, c]] of refuses.entries()) await fs.writeFile(path.join(fixtures, leaks[i]), JSON.stringify(c));
    const r = spawnSync("npx", ["tsx", path.join(REPO_ROOT, "scripts", "scan-committed-cassettes.ts"), fixtures], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(r.status).toBe(1);
    for (const f of leaks) expect(r.stderr).toContain(f);
    for (const f of clean) expect(r.stderr).not.toContain(f);
    expect(r.stderr).toContain(`${leaks.length} of ${leaks.length + clean.length}`);
  });
});
