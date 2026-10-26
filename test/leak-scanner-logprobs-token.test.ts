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

  it("the committed-cassette rescan passes every logprobs row and refuses every control", async () => {
    const fixtures = path.join(dir, "fixtures");
    await fs.mkdir(fixtures);
    // Indexed: two labels differing only in case collide on macOS.
    const name = (kind: string, i: number, label: string) => `${kind}-${i}-${label.replace(/\W+/g, "-")}.json`;
    const clean = RECORDS.map(([label], i) => name("clean", i, label));
    const leaks = REFUSES.map(([label], i) => name("leak", i, label));
    for (const [i, [, c]] of RECORDS.entries()) await fs.writeFile(path.join(fixtures, clean[i]), JSON.stringify(c));
    for (const [i, [, c]] of REFUSES.entries()) await fs.writeFile(path.join(fixtures, leaks[i]), JSON.stringify(c));
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
