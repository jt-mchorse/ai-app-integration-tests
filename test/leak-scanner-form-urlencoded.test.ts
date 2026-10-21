/**
 * The leak scanner reads a form-urlencoded string as what it says (#237), and
 * reads an object KEY as well as its value (#238).
 *
 * #237: `normalizeUrl` rebuilds the query with `searchParams.append`, and a
 * `URLSearchParams` body is stored as its `toString()`. Both encode `/` as
 * `%2F`, `+` as `%2B`, `=` as `%3D` and a space as `+`, so the `key=` family
 * stopped at the first `%` and `Bearer\s+` / `Basic\s+` never matched
 * `Bearer+`. The key was sent live, written, and the committed-cassette rescan
 * passed it.
 *
 * #238: `scanTexts` walked only `Object.values`. A key was seen only through
 * `JSON.stringify`, where `\n` before `sk-` kills the leading `\b`, the gap #183
 * closed for values.
 *
 * Every REFUSE row was written on `main` (29d3b89). The controls are shapes
 * that were already refused, and the ALLOW rows are ordinary encoded traffic
 * that has to stay accepted.
 */
import { spawnSync } from "node:child_process";
import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";
import { CassetteStore, createRecorderFetch } from "../src/index.js";

// A key with a `+` in it, as the hunt agent sent it; `+` is `%2B` on the wire.
const PLUS_KEY = "abcdefghij+klmnopqrstuvwxyz0123456789";
// The AWS documentation example secret: `/` is `%2F` on the wire.
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const OPAQUE32 = "Xk92mNq7ZbT4wLp1RvY8sJd3HgFc6EuA";
const SKANT = "sk-ant-api03-" + "A".repeat(40);
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const enc = encodeURIComponent;

function base(request: Partial<CassetteV1["request"]>, responseBody: string): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "0".repeat(32),
    request: { method: "GET", url: "https://api.example.com/v1", headers: {}, body: null, ...request },
    response: { kind: "non_streaming", status: 200, headers: {}, body: responseBody },
    recorded_at: "2026-10-21T00:00:00Z",
  };
}

/** A URL exactly as the recorder writes it (`normalizeUrl` re-encodes the query). */
const url = (query: Record<string, string>): string =>
  `https://api.example.com/v1?${new URLSearchParams(query).toString()}`;
/** A `URLSearchParams` request body as the recorder stores it. */
const formBody = (fields: Record<string, string>): Partial<CassetteV1["request"]> => ({
  method: "POST",
  body: new URLSearchParams(fields).toString(),
  bodyEncoding: "raw",
});

const REFUSE: Array<[string, CassetteV1, string]> = [
  // #237
  ["URL ?api_key=<key with '+' stored as %2B>", base({ url: url({ api_key: PLUS_KEY }) }, "ok"), "the request URL"],
  ["URL ?api_key=<AWS secret, '/' stored as %2F>", base({ url: url({ api_key: AWS_SECRET }) }, "ok"), "the request URL"],
  [
    "URL ?authorization=Bearer <token> (stored as Bearer+)",
    base({ url: url({ authorization: `Bearer ${OPAQUE32}` }) }, "ok"),
    "the request URL",
  ],
  [
    "URL ?h=Basic <base64> (stored as Basic+, padding as %3D)",
    base({ url: url({ h: "Basic dXNlcjpwYXNzd29yZDEyMw==" }) }, "ok"),
    "the request URL",
  ],
  [
    "URL ?payload=<encoded JSON {access_token}>",
    base({ url: url({ payload: JSON.stringify({ access_token: OPAQUE32 }) }) }, "ok"),
    "the request URL",
  ],
  ["URLSearchParams request body {api_key}", base(formBody({ api_key: PLUS_KEY }), "ok"), "the request body"],
  [
    "URLSearchParams request body, access_token second",
    base(formBody({ grant_type: "client_credentials", access_token: AWS_SECRET }), "ok"),
    "the request body",
  ],
  [
    "form-encoded response body (an OAuth token endpoint)",
    base({}, new URLSearchParams({ access_token: AWS_SECRET, token_type: "bearer" }).toString()),
    "the response",
  ],
  // #238
  [
    "response JSON key, a newline then sk-ant",
    base({}, JSON.stringify({ [`note${NL}${SKANT}`]: 1 })),
    "the response",
  ],
  [
    "response JSON nested object's key, a tab then sk-ant",
    base({}, JSON.stringify({ data: { items: [{ [`x${TAB}${SKANT}`]: true }] } })),
    "the response",
  ],
  [
    "request JSON body key, a newline then sk-ant",
    base({ method: "POST", body: { [`label${NL}${SKANT}`]: "v" } }, "ok"),
    "the request body",
  ],
];

// Already refused before #237/#238; they stay refused.
const CONTROLS: Array<[string, CassetteV1, string]> = [
  ["string body api_key=<key>, unencoded", base({ method: "POST", body: `api_key=${PLUS_KEY}`, bodyEncoding: "raw" }, "ok"), "the request body"],
  ["JSON body {api_key}", base({ method: "POST", body: { api_key: PLUS_KEY } }, "ok"), "the request body"],
  ["URL ?api_key=<hex>, nothing to encode", base({ url: url({ api_key: "a1b2c3d4e5f60718293a4b5c6d7e8f90" }) }, "ok"), "the request URL"],
  ["the #238 text as a VALUE", base({}, JSON.stringify({ k: `note${NL}${SKANT}` })), "the response"],
];

const ALLOW: Array<[string, CassetteV1]> = [
  ["URL ?q=a%2Fb", base({ url: "https://api.example.com/v1?q=a%2Fb" }, "ok")],
  ["URL ?q=hello+world&page=2", base({ url: url({ q: "hello world", page: "2" }) }, "ok")],
  ["URL ?redirect_uri=<encoded https URL>", base({ url: url({ redirect_uri: "https://example.com/callback/path" }) }, "ok")],
  ["URL ?model=<long value with + and />", base({ url: url({ model: "claude-haiku-4-5+extended/thinking-preview" }) }, "ok")],
  [
    "URLSearchParams body of ordinary fields",
    base(formBody({ grant_type: "client_credentials", scope: "read write", request_id: `req_${OPAQUE32}` }), "ok"),
  ],
  ["response JSON with ordinary keys, one after a newline", base({}, JSON.stringify({ [`note${NL}hello`]: 1, model: "claude" }))],
  ["prose with + and = in it", base({}, "1+1=2 and the Basic+plan costs %10 less")],
];

describe("form-urlencoded strings and object keys are scanned as what they say (#237, #238)", () => {
  it.each(REFUSE)("refuses: %s", (_name, cassette, where) => {
    expect(() => assertNoLeakedSecrets(cassette)).toThrow(new RegExp(`in ${where}`));
  });

  it.each(CONTROLS)("still refuses (control): %s", (_name, cassette, where) => {
    expect(() => assertNoLeakedSecrets(cassette)).toThrow(new RegExp(`in ${where}`));
  });

  it.each(ALLOW)("allows: %s", (_name, cassette) => {
    expect(() => assertNoLeakedSecrets(cassette)).not.toThrow();
  });
});

describe("the recorder refuses them before writing (#237, #238)", () => {
  let dir: string;
  let calls: number;
  let responseBody: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-form-leak-"));
    calls = 0;
    responseBody = '{"ok":true}';
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function recorder() {
    const upstream = (async () => {
      calls += 1;
      return new Response(responseBody, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: new Set(["api.example.com"]) });
  }
  const written = async () => (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).length;

  it.each([
    ["a ?api_key= query whose key holds '+'", `https://api.example.com/a?api_key=${enc(PLUS_KEY)}`, { method: "GET" }, "the request URL"],
    ["a URLSearchParams body", "https://api.example.com/b", { method: "POST", body: new URLSearchParams({ api_key: PLUS_KEY }) }, "the request body"],
  ] as const)("%s: refused with zero upstream calls", async (_name, target, init, where) => {
    await expect(recorder()(target, init as RequestInit)).rejects.toThrow(new RegExp(`in (?:${where})`));
    expect(calls).toBe(0);
    expect(await written()).toBe(0);
  });

  it("an upstream that answers with a credential in a JSON key: refused, nothing written", async () => {
    responseBody = JSON.stringify({ [`note${NL}${SKANT}`]: 1 });
    await expect(recorder()("https://api.example.com/c", { method: "GET" })).rejects.toThrow("in the response");
    expect(await written()).toBe(0);
  });

  it("a benign encoded query is recorded (control)", async () => {
    await recorder()("https://api.example.com/d?q=a%2Fb", { method: "GET" });
    expect(calls).toBe(1);
    expect(await written()).toBe(1);
  });
});

describe("scripts/scan-committed-cassettes.ts flags them (#237, #238)", () => {
  const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
  const SCRIPT = path.join(REPO_ROOT, "scripts", "scan-committed-cassettes.ts");
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });

  function fixturesWith(cassettes: CassetteV1[]): string {
    const d = mkdtempSync(path.join(os.tmpdir(), "aiapp-form-rescan-"));
    tempDirs.push(d);
    cassettes.forEach((c, i) => writeFileSync(path.join(d, `c${i}.json`), JSON.stringify(c, null, 2)));
    return d;
  }
  const scan = (d: string) =>
    spawnSync("npx", ["tsx", SCRIPT, d], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });

  // One spawn for every row: the count in the summary is what proves each was refused.
  it(`refuses every one of the ${REFUSE.length} rows`, () => {
    const r = scan(fixturesWith(REFUSE.map(([, c]) => c)));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${REFUSE.length} of ${REFUSE.length} cassette(s)`);
  });

  it(`passes every one of the ${ALLOW.length} allow rows (control)`, () => {
    const r = scan(fixturesWith(ALLOW.map(([, c]) => c)));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`in ${ALLOW.length} cassette(s)`);
  });
});
