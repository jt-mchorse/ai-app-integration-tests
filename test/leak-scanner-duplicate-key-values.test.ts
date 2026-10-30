/**
 * The leak scanner reads every value of a repeated key (#273).
 *
 * `scanTexts` parses a JSON-looking string and scans the parse. `JSON.parse`
 * keeps only the last value of a repeated key, so an earlier value was never
 * read decoded, and the raw text did not catch it either: after a `\n` escape
 * the key reads `\nsk-…`, where `\bsk-` cannot match (#183). Since #271 a
 * request body with a repeated key is stored as its text, so the dropped value
 * reached the cassette. Measured on main (2d26ce7) with the recorder and
 * `scripts/scan-committed-cassettes.ts`: `{"model":"m","note":"see\nKEY",
 * "note":"ok"}` was recorded with KEY in the file and the rescan reported "no
 * leaked secrets found in 1 cassette(s)"; the response `{"error":"bad
 * key\nKEY","error":"x"}` the same. Without the repeat both were refused.
 *
 * The credential is built at runtime so no key-shaped literal is committed.
 */
import { spawnSync } from "node:child_process";
import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";
import { CassetteStore, createRecorderFetch } from "../src/index.js";
import { parseKeepingDuplicates } from "../src/json-text.js";

const KEY = "sk-" + "A".repeat(40);
const HEX32 = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
// A JSON `\n` escape, built from code points so no escape here does the work.
const ESC_N = String.fromCharCode(92) + "n";
const NL = String.fromCharCode(10);

const REQ_DUP = `{"model":"m","note":"see${ESC_N}${KEY}","note":"ok"}`;
const REQ_ONE = `{"model":"m","note":"see${ESC_N}${KEY}"}`;
const RESP_DUP = `{"error":"bad key${ESC_N}${KEY}","error":"x"}`;
const RESP_ONE = `{"error":"bad key${ESC_N}${KEY}"}`;

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

// Each row: a cassette whose only credential sits in a value the parse drops.
const REFUSE: Array<[string, CassetteV1]> = [
  ["request body, escaped sk- under a repeated key", cassette(REQ_DUP, OK)],
  ["response body, escaped sk- under a repeated key", cassette(null, text(RESP_DUP))],
  ["SSE data payload, escaped sk- under a repeated key", cassette(null, sse(`data: ${RESP_DUP}${NL}${NL}`))],
  ["middle of three repeats", cassette(`{"n":"ok","n":"x${ESC_N}${KEY}","n":"ok"}`, OK)],
  ["repeat in a nested object", cassette(`{"a":{"b":{"n":"x${ESC_N}${KEY}","n":"ok"}}}`, OK)],
  ["repeat in an object inside an array", cassette(`[1,{"n":"x${ESC_N}${KEY}","n":"ok"}]`, OK)],
  [
    "repeat in JSON held by a string of a body without one",
    cassette(null, text(JSON.stringify({ wrapped: `{"n":"x${ESC_N}${KEY}","n":"ok"}` }))),
  ],
  // The key is spelled with an escape, so the raw text never reads `api_key`;
  // the dropped member, read with its key beside it, does.
  ["key-named 32-hex under an escaped key repeated", cassette(`{"api\\u005fkey":"${HEX32}","api_key":"x"}`, OK)],
];

// The same credentials without the repeat: refused on main already.
const CONTROLS: Array<[string, CassetteV1]> = [
  ["request body without the repeat", cassette(REQ_ONE, OK)],
  ["response body without the repeat", cassette(null, text(RESP_ONE))],
  ["key-named 32-hex without the repeat", cassette(`{"api\\u005fkey":"${HEX32}"}`, OK)],
];

// Repeated keys with nothing secret in them must still record.
const ALLOW: Array<[string, CassetteV1]> = [
  ["benign repeat", cassette('{"model":"a","model":"b"}', OK)],
  ["benign repeat with an escape", cassette(`{"note":"see${ESC_N}nothing","note":"ok"}`, OK)],
  ["repeated __proto__", cassette('{"__proto__":"x","__proto__":{"y":1}}', OK)],
  ["benign repeat in a response and an SSE frame", cassette(null, sse('data: {"t":"a","t":"b"}\n\n'))],
];

describe("assertNoLeakedSecrets reads every value of a repeated key (#273)", () => {
  for (const [name, c] of REFUSE) {
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

describe("parseKeepingDuplicates (#273)", () => {
  it("lists every member of an object that repeats a key, in order", () => {
    expect(parseKeepingDuplicates('{"a":1,"b":[true,null],"a":"x"}')).toEqual([
      { a: 1 },
      { b: [true, null] },
      { a: "x" },
    ]);
    expect(parseKeepingDuplicates('{"n":{"a":1,"a":2}}')).toEqual({ n: [{ a: 1 }, { a: 2 }] });
  });

  it("parses a text without a repeat exactly as JSON.parse does", () => {
    const texts = [
      "{}",
      "[]",
      ' { "a" : [ 1 , -2.5e3 , "x\\"y" , { } , [ ] ] , "b" : { "c" : null } }\n',
      '"just a string"',
      "-0",
      "true",
      '{"\\u0061":"\\ud83d\\ude00","a\\/b":"\\\\"}',
      '[{"a":1},{"a":2}]',
    ];
    for (const t of texts) expect(parseKeepingDuplicates(t)).toStrictEqual(JSON.parse(t));
  });

  it("keeps a __proto__ key as a member, as JSON.parse does", () => {
    const one = parseKeepingDuplicates('{"__proto__":1}') as Record<string, unknown>;
    expect(Object.keys(one)).toEqual(["__proto__"]);
    const two = parseKeepingDuplicates('{"__proto__":1,"__proto__":2}') as Array<Record<string, unknown>>;
    expect(two.map((m) => Object.entries(m))).toEqual([[["__proto__", 1]], [["__proto__", 2]]]);
  });
});

describe("the recorder refuses a credential under a repeated key (#273)", () => {
  const HOSTS = new Set(["api.example.com"]);
  let dir: string;
  let calls: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-dupval-"));
    calls = 0;
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function record(body: string, upstreamBody: string): Promise<unknown> {
    const upstream = (async () => {
      calls += 1;
      return new Response(upstreamBody, { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const rec = createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
    try {
      await rec("https://api.example.com/v1/x", { method: "POST", body });
      return null;
    } catch (err) {
      return err;
    }
  }

  it("refuses the request body before the live call and writes nothing", async () => {
    const err = await record(REQ_DUP, '{"ok":true}');
    expect(String(err)).toMatch(/unredacted secret/);
    expect(calls).toBe(0);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("refuses the response body and writes nothing", async () => {
    const err = await record('{"model":"m"}', RESP_DUP);
    expect(String(err)).toMatch(/unredacted secret/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("control: records a benign repeated-key body and response", async () => {
    expect(await record('{"model":"a","model":"b"}', '{"t":"a","t":"b"}')).toBeNull();
    expect(await fs.readdir(dir)).toHaveLength(1);
  });
});

describe("scan-committed-cassettes refuses a credential under a repeated key in a body (#273)", () => {
  const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
  const SCRIPT = path.join(REPO_ROOT, "scripts", "scan-committed-cassettes.ts");
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function scan(files: Record<string, CassetteV1>) {
    const d = mkdtempSync(path.join(os.tmpdir(), "aiit-dupval-scan-"));
    dirs.push(d);
    for (const [name, c] of Object.entries(files)) writeFileSync(path.join(d, name), JSON.stringify(c, null, 2));
    return spawnSync("npx", ["tsx", SCRIPT, d], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
  }

  it("refuses both the request-side and the response-side cassette, naming each", () => {
    const r = scan({ "req.json": cassette(REQ_DUP, OK), "resp.json": cassette(null, text(RESP_DUP)) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("req.json");
    expect(r.stderr).toContain("resp.json");
    expect(r.stderr).toContain("2 of 2 cassette(s)");
  }, 120_000);

  it("control: passes a cassette whose body repeats a key with nothing secret", () => {
    const r = scan({ "benign.json": cassette('{"model":"a","model":"b"}', text('{"t":"a","t":"b"}')) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no leaked secrets found in 1 cassette(s)");
  }, 120_000);
});
