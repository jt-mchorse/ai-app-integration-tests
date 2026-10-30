/**
 * The leak scanner decodes a JSON string literal, and its nesting cap fails
 * closed (#275).
 *
 * `scanTexts` parsed only a candidate starting with `{` or `[`. A top-level
 * JSON string is JSON too, and its escapes were never decoded: a `"…"` body, an
 * SSE `data: "…"` payload, a string NDJSON line, and a double-encoded body
 * (a proxy that stringifies JSON). Separately, `MAX_NESTED_JSON_DEPTH` returned
 * silently, so a key in `{inner: JSON.stringify(...)}` wrapped four or more
 * times was never read decoded. Measured on main (db760dc) with the recorder
 * and `scripts/scan-committed-cassettes.ts`: the double-encoded `access_token`,
 * the string body and the SSE string payload were recorded with the secret on
 * disk and the rescan exited 0; wrapped 1-3 times was refused, 4-6 times
 * recorded and passed the rescan.
 *
 * Credentials are built at runtime so no key-shaped literal is committed.
 */
import { spawnSync } from "node:child_process";
import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";
import { CassetteStore, createRecorderFetch } from "../src/index.js";

const KEY = "sk-" + "A".repeat(40);
const HEX32 = "a1b2".repeat(8);
const NL = String.fromCharCode(10);

/** `base` as JSON, inside `{inner: <JSON text>}` `n` times. */
function wrapped(n: number, base: unknown): string {
  let v = base;
  for (let i = 0; i < n; i++) v = { inner: JSON.stringify(v) };
  return JSON.stringify(v);
}

function cassette(body: string | null, response: CassetteV1["response"]): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "abc",
    request: { method: "POST", url: "https://api.example.com/v1/x", headers: {}, body, bodyEncoding: "raw" },
    response,
    recorded_at: "2026-10-30T00:00:00Z",
  };
}
const text = (body: string): CassetteV1["response"] => ({ kind: "non_streaming", status: 200, headers: {}, body });
const sse = (...frames: string[]): CassetteV1["response"] => ({ kind: "sse", status: 200, headers: {}, frames });
const OK = text('{"ok":true}');

const DOUBLE_TOKEN = JSON.stringify(JSON.stringify({ access_token: HEX32 }));
const STRING_KEY = JSON.stringify("invalid key" + NL + KEY);

// A JSON string literal that hides a credential behind its escapes.
const REFUSE_STRING: Array<[string, CassetteV1]> = [
  ["double-encoded response with an access_token", cassette(null, text(DOUBLE_TOKEN))],
  ["triple-encoded response with an access_token", cassette(null, text(JSON.stringify(DOUBLE_TOKEN)))],
  ["JSON string response body, sk- after an escaped newline", cassette(null, text(STRING_KEY))],
  ["JSON string request body", cassette(STRING_KEY, OK)],
  ["SSE data payload that is a JSON string", cassette(null, sse(`data: ${STRING_KEY}${NL}${NL}`))],
  ["NDJSON line that is a JSON string", cassette(null, text(`{"ok":1}${NL}${STRING_KEY}${NL}`))],
  ["JSON string held in an object's value", cassette(null, text(JSON.stringify({ body: DOUBLE_TOKEN })))],
];

// The same credentials inside an object: refused on main already.
const CONTROLS: Array<[string, CassetteV1]> = [
  ["single-encoded access_token", cassette(null, text(JSON.stringify({ access_token: HEX32 })))],
  ["object response, sk- after an escaped newline", cassette(null, text(JSON.stringify({ e: "x" + NL + KEY })))],
  ["SSE object payload", cassette(null, sse(`data: ${JSON.stringify({ t: "x" + NL + KEY })}${NL}${NL}`))],
  ...[0, 1, 2, 3].map((n): [string, CassetteV1] => [
    `key wrapped ${n} time(s), under the cap`,
    cassette(null, text(wrapped(n, { e: "x" + NL + KEY }))),
  ]),
];

// Benign JSON strings and nesting under the cap must still record.
const ALLOW: Array<[string, CassetteV1]> = [
  ["JSON string body", cassette('"hello"', text('"world"'))],
  ["double-encoded benign object", cassette(null, text(JSON.stringify(JSON.stringify({ a: "b" }))))],
  ["SSE data payload that is a benign JSON string", cassette(null, sse(`data: "hi${"\\n"}there"${NL}${NL}`))],
  ["quoted words in a value", cassette(JSON.stringify({ text: '"quoted" words' }), OK)],
  ["benign object wrapped 3 times", cassette(null, text(wrapped(3, { e: "hello" })))],
];

describe("assertNoLeakedSecrets decodes a JSON string literal (#275)", () => {
  for (const [name, c] of REFUSE_STRING) {
    it(`refuses: ${name}`, () => {
      expect(() => assertNoLeakedSecrets(c)).toThrow(/unredacted secret/);
    });
  }
  for (const [name, c] of CONTROLS) {
    it(`control, refuses: ${name}`, () => {
      expect(() => assertNoLeakedSecrets(c)).toThrow(/unredacted secret/);
    });
  }
  for (const [name, c] of ALLOW) {
    it(`accepts: ${name}`, () => {
      expect(() => assertNoLeakedSecrets(c)).not.toThrow();
    });
  }
});

describe("the nested-JSON cap fails closed (#275)", () => {
  for (const n of [4, 5, 6]) {
    it(`refuses a key wrapped ${n} times`, () => {
      expect(() => assertNoLeakedSecrets(cassette(null, text(wrapped(n, { e: "x" + NL + KEY }))))).toThrow(
        /nested inside strings more than 4 levels deep.*refusing to write/,
      );
    });
  }

  it("refuses JSON still nested at the cap even with nothing secret in it", () => {
    expect(() => assertNoLeakedSecrets(cassette(null, text(wrapped(4, { e: "hello" }))))).toThrow(
      /nested inside strings/,
    );
    expect(() => assertNoLeakedSecrets(cassette(wrapped(4, { e: "hello" }), OK))).toThrow(/nested inside strings/);
  });

  it("accepts a plain string at the cap: only a text that parses is refused", () => {
    expect(() => assertNoLeakedSecrets(cassette(null, text(wrapped(3, { e: "{not json" }))))).not.toThrow();
  });

  it("still URL-decodes a string at the cap, which the early return skipped", () => {
    // Form-encoded JSON at depth 4. Every outer text URL-decodes to the same
    // JSON with the outer layers' `\"}` glued on, which does not parse, so
    // only the pass at the cap reads it -- and it parses, so it is refused.
    const json = JSON.stringify({ a: "x" + NL + KEY });
    const c = cassette(null, text(wrapped(3, { q: `q=${encodeURIComponent(json)}` })));
    expect(() => assertNoLeakedSecrets(c)).toThrow(/refusing to write/);
  });

  it("control: the same form-encoded JSON under the cap is read and refused as a secret", () => {
    const json = JSON.stringify({ a: "x" + NL + KEY });
    const c = cassette(null, text(wrapped(2, { q: `q=${encodeURIComponent(json)}` })));
    expect(() => assertNoLeakedSecrets(c)).toThrow(/unredacted secret/);
  });
});

describe("the recorder refuses a JSON string or over-nested body (#275)", () => {
  const HOSTS = new Set(["api.example.com"]);
  let dir: string;
  let calls: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-jsonstr-"));
    calls = 0;
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function record(body: string, upstreamBody: string, contentType = "application/json"): Promise<unknown> {
    const upstream = (async () => {
      calls += 1;
      return new Response(upstreamBody, { headers: { "content-type": contentType } });
    }) as typeof fetch;
    const rec = createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
    try {
      const res = await rec("https://api.example.com/v1/x", { method: "POST", body });
      await res.text();
      return null;
    } catch (err) {
      return err;
    }
  }

  it("refuses a double-encoded response and writes nothing", async () => {
    expect(String(await record('{"q":1}', DOUBLE_TOKEN))).toMatch(/unredacted secret/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("refuses an SSE data payload that is a JSON string and writes nothing", async () => {
    const err = await record('{"q":1}', `data: ${STRING_KEY}\n\n`, "text/event-stream");
    expect(String(err)).toMatch(/unredacted secret/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  // The recorder stores a JSON request body parsed, so the scan already read
  // this string decoded on main; the raw-stored row above is the one that was red.
  it("control: refuses a JSON string request body before the live call", async () => {
    expect(String(await record(STRING_KEY, '{"ok":true}'))).toMatch(/unredacted secret/);
    expect(calls).toBe(0);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("refuses a response wrapped past the cap and writes nothing", async () => {
    expect(String(await record('{"q":1}', wrapped(4, { e: "x" + NL + KEY })))).toMatch(/nested inside strings/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("control: records a benign JSON string body and a double-encoded response", async () => {
    expect(await record('"hello"', JSON.stringify(JSON.stringify({ a: "b" })))).toBeNull();
    expect(await fs.readdir(dir)).toHaveLength(1);
  });
});

describe("scan-committed-cassettes refuses a JSON string or over-nested body (#275)", () => {
  const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
  const SCRIPT = path.join(REPO_ROOT, "scripts", "scan-committed-cassettes.ts");
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function scan(files: Record<string, CassetteV1>) {
    const d = mkdtempSync(path.join(os.tmpdir(), "aiit-jsonstr-scan-"));
    dirs.push(d);
    for (const [name, c] of Object.entries(files)) writeFileSync(path.join(d, name), JSON.stringify(c, null, 2));
    return spawnSync("npx", ["tsx", SCRIPT, d], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
  }

  it("refuses double-encoded, string-literal and over-nested cassettes, naming each", () => {
    const r = scan({
      "double.json": cassette(null, text(DOUBLE_TOKEN)),
      "string.json": cassette(null, text(STRING_KEY)),
      "nested.json": cassette(null, text(wrapped(5, { e: "x" + NL + KEY }))),
    });
    expect(r.status).toBe(1);
    for (const f of ["double.json", "string.json", "nested.json"]) expect(r.stderr).toContain(f);
    expect(r.stderr).toContain("3 of 3 cassette(s)");
  }, 120_000);

  it("control: passes benign JSON strings and nesting under the cap", () => {
    const r = scan({
      "benign.json": cassette('"hello"', text(JSON.stringify(JSON.stringify({ a: "b" })))),
      "nested.json": cassette(null, text(wrapped(3, { e: "hello" }))),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no leaked secrets found in 2 cassette(s)");
  }, 120_000);
});
