/**
 * A JSON body with a repeated key is not hashed as its last-wins parse (#270).
 *
 * `JSON.parse` keeps the last value of a repeated key, so `normalizeRequest`
 * hashed `{"model":"a","model":"b"}` as `{"model":"b"}`. Measured on main
 * (ac72e13), 7 bodies recorded 4 cassettes, and replaying the duplicate served
 * the other request's response, at the top level, in a nested object, and for a
 * key spelled with an escape (`"\u0061"` is `"a"`). A server that keeps the first
 * value or refuses the body reads them differently. #267 hashes a body the parse
 * loses a number from as its text under `raw`; this applies the same rule to the
 * loss #216 names, through the scanner's own `duplicateKey`, now shared from
 * `src/json-text.ts`. Every other body keeps its hash, pinned below.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, MissingCassetteError, canonicalize, createRecorderFetch, createReplayerFetch } from "../src/index.js";
import { duplicateKey } from "../src/json-text.js";

const HOSTS = new Set(["api.example.com"]);
const URL_ = "https://api.example.com/v1/x";
let dir: string;
let store: CassetteStore;
let upstreamCalls: number;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-dupkey-"));
  store = new CassetteStore({ dir });
  upstreamCalls = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// Echoes the body it was sent, so a replay shows whose response it served.
const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  upstreamCalls += 1;
  return new Response(JSON.stringify({ echo: init?.body ?? null }), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

async function record(body: string): Promise<void> {
  const rec = createRecorderFetch({ upstream, store, hosts: HOSTS });
  await rec(URL_, { method: "POST", body });
}

async function replayEcho(body: string): Promise<unknown> {
  const rep = createReplayerFetch({ store, hosts: HOSTS });
  const r = await rep(URL_, { method: "POST", body });
  return ((await r.json()) as { echo: unknown }).echo;
}

async function cassettes(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
}

async function hashOf(body: string): Promise<string> {
  await record(body);
  const files = await cassettes();
  expect(files).toHaveLength(1);
  return files[0].replace(/\.json$/, "");
}

// Each pair: a body with a repeated key, and the body its last-wins parse equals.
const COLLIDING_PAIRS: Array<[string, string, string]> = [
  ["top level", '{"model":"a","model":"b"}', '{"model":"b"}'],
  ["in a nested object", '{"m":{"x":1,"x":2}}', '{"m":{"x":2}}'],
  ["in an object inside an array", '{"messages":[{"role":"user","role":"system"}]}', '{"messages":[{"role":"system"}]}'],
  ["deep", '{"a":[[{"b":{"c":1,"c":2}}]]}', '{"a":[[{"b":{"c":2}}]]}'],
  ["after a nested object closes", '{"a":1,"b":{"c":1},"a":2}', '{"b":{"c":1},"a":2}'],
  ["three times", '{"k":1,"k":2,"k":3}', '{"k":3}'],
  ["a key spelled with a \\u escape", '{"\\u0061":1,"a":2}', '{"a":2}'],
  ["a key spelled with a \\/ escape", '{"a/b":1,"a\\/b":2}', '{"a/b":2}'],
  ["whitespace around the tokens", ' { "a" : 1 ,\n "a" : 2 } ', '{"a":2}'],
  ["a repeated key whose values are equal", '{"a":1,"a":1}', '{"a":1}'],
];

describe("a body with a repeated key is its own cassette (#270)", () => {
  for (const [name, a, b] of COLLIDING_PAIRS) {
    it(`${name}: two cassettes, and each replays its own response`, async () => {
      expect(duplicateKey(a)).not.toBeNull();
      expect(duplicateKey(b)).toBeNull();
      // Anti-vacuous: the parse really makes them one body.
      expect(JSON.stringify(canonicalize(JSON.parse(a)))).toBe(JSON.stringify(canonicalize(JSON.parse(b))));
      await record(a);
      await record(b);
      expect(await cassettes()).toHaveLength(2);
      expect(await replayEcho(a)).toBe(a);
      expect(await replayEcho(b)).toBe(b);
    });
  }

  it("the cassette records the body as sent", async () => {
    await record('{"model":"a","model":"b"}');
    const [f] = await cassettes();
    const cassette = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
    expect(cassette.request.body).toBe('{"model":"a","model":"b"}');
    expect(cassette.request.bodyEncoding).toBe("raw");
  });

  it("the same body sent twice replays from one cassette", async () => {
    await record('{"model":"a","model":"b"}');
    await record('{"model":"a","model":"b"}');
    expect(await cassettes()).toHaveLength(1);
  });

  it("hashing by text: the duplicate in another order misses loudly instead of misserving", async () => {
    await record('{"model":"a","model":"b"}');
    const rep = createReplayerFetch({ store, hosts: HOSTS });
    await expect(rep(URL_, { method: "POST", body: '{"model":"b","model":"a"}' })).rejects.toBeInstanceOf(
      MissingCassetteError,
    );
  });

  it("a credential under a repeated key is refused before the live call", async () => {
    // The parse dropped it, so main recorded a clean-looking cassette for a
    // body that sent the credential. The text is now the hash key, so the
    // recorder's leak scan sees it and refuses before anything goes out.
    const key = `sk-ant-api03-${"A".repeat(40)}`;
    const rec = createRecorderFetch({ upstream, store, hosts: HOSTS });
    await expect(
      rec(URL_, { method: "POST", body: `{"api_key":"${key}","api_key":"[REDACTED]"}` }),
    ).rejects.toThrow(/unredacted secret/);
    expect(upstreamCalls).toBe(0);
    expect(await cassettes()).toHaveLength(0);
  });
});

describe("duplicateKey counts one object at a time (#270)", () => {
  it.each([
    ['[{"k":1},{"k":2}]'],
    ['{"a":{"k":1},"b":{"k":2}}'],
    ['{"k":{"k":{"k":1}}}'],
    ['{"a":"a","b":"a"}'],
    ['{"a":1,"A":2}'],
    ['{"s":"\\"a\\":1,\\"a\\":2"}'],
    ['{"\\u00e9":1,"e\\u0301":2}'],
  ])("%s has no repeat", (text) => {
    expect(duplicateKey(text)).toBeNull();
  });

  it("names the repeated key decoded", () => {
    expect(duplicateKey('{"\\u0061":1,"a":2}')).toBe("a");
    expect(duplicateKey('{"x":[{"y":1,"y":2}]}')).toBe("y");
  });
});

// #267's table, captured on ee87607, then bodies with one key in several
// objects (or a value spelled like a key), captured on ac72e13 before this fix.
const PR267_HASHES: Array<[string, string]> = [
  ["{\"n\":0}", "74e5a894ce65dfe4e5e8a5b237c6ddfb"],
  ["{\"n\":-0}", "74e5a894ce65dfe4e5e8a5b237c6ddfb"],
  ["{\"n\":1}", "5aa64117f377f83a98df5eb32978f7e8"],
  ["{\"n\":1.0}", "5aa64117f377f83a98df5eb32978f7e8"],
  ["{\"n\":1e2}", "0a01ed9d004b592b8202c4ae05430b5d"],
  ["{\"n\":100}", "0a01ed9d004b592b8202c4ae05430b5d"],
  ["{\"n\":1E2}", "0a01ed9d004b592b8202c4ae05430b5d"],
  ["{\"n\":1e+2}", "0a01ed9d004b592b8202c4ae05430b5d"],
  ["{\"n\":0.1}", "87f0610e96c8258c62873298cab0fc76"],
  ["{\"n\":-3.5e-7}", "111cb52196845426508c07a69d60d689"],
  ["{\"n\":1e-400}", "74e5a894ce65dfe4e5e8a5b237c6ddfb"],
  ["{\"n\":9007199254740991}", "a3f2528f748fb998d9514fef47aded05"],
  ["{\"n\":9007199254740992}", "bef081e4824f0ab65699a3df8c30942b"],
  ["{\"n\":-9007199254740992}", "10d13800a7ead0400ee44dd5d6849834"],
  ["{\"n\":18014398509481984}", "5d8dcbab052e71fbd88d42e7a5f26a83"],
  ["{\"n\":1e21}", "49c1fb5c36ca8a157c96f4645005968c"],
  ["{\"n\":1000000000000000000000}", "49c1fb5c36ca8a157c96f4645005968c"],
  ["{\"n\":1.7976931348623157e308}", "adf1eb99710b33f992e0a8e32d58484c"],
  ["{\"n\":9007199254740993.0}", "bef081e4824f0ab65699a3df8c30942b"],
  ["{\"n\":9.007199254740993e15}", "bef081e4824f0ab65699a3df8c30942b"],
  ["{\"temperature\":0.7,\"max_tokens\":1024,\"model\":\"claude\",\"messages\":[{\"role\":\"user\",\"content\":\"seed 9007199254740993 and 1e400\"}]}", "876ceb89847d020d27f611343e864c24"],
  ["{\"b\":2,\"a\":[1,2.5,{\"z\":-1,\"y\":[3e0]}]}", "50ffc554bf6579a27e2c98b770b4c35f"],
  ["[1,2,3]", "d27f530da99f53ddd3495db344c4b067"],
  ["42", "15fbebd3ed4378ae641676541b60ceb6"],
  ["\"9007199254740993\"", "433dcfc5dc269364710c37748858cdcb"],
  ["null", "d2d1fb2cd304471b9646762579b6b891"],
  ["{\"s\":\"\\\"9007199254740993\"}", "d76c80c2aa3adc3f7e09e11f2f528ec8"],
  ["{\"9007199254740993\":1}", "25b18a4b23b068922d1f6f61e23a56d8"],
  ["{\"s\":\"a\\\\\",\"n\":1}", "f329de4618b012aeb340d42fd3c7df05"],
  ["{\"s\":\"1e400\"}", "19897aabad6b82889037877b9d11749d"],
  ["{\"s\":\"x\",\"n\":[9007199254740992,1e308,-1.5]}", "902775cd9837c7db415a2737504eb23f"],
  ["{\"s\":\"\\u0022 12345678901234567 \\\\\"}", "1281292128c5320f6785a3a5448a6947"],
  ["{\"n\":-9007199254740991}", "c29c2bfa7a1861e0cc6a317bd57385c8"],
  ["[{\"k\":1},{\"k\":2}]","962505bf509015c3c5f5806993733867"],
  ["{\"a\":{\"k\":1},\"b\":{\"k\":2}}","329a2d3bb82e93aa5d73baed11a68ebb"],
  ["{\"k\":{\"k\":{\"k\":1}}}","0842f9e032dee2b6335858d93cc3ef5d"],
  ["{\"a\":\"a\",\"b\":\"a\"}","cb3744abcfd28f42d96b126a532def86"],
  ["{\"a\":[\"a\",\"a\"]}","abb4321891dd1188f945f5a33a883e27"],
  ["{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"assistant\",\"content\":\"yo\"}],\"model\":\"m\"}","d693139834e7f1e0af90b2f9b05ef009"],
  ["{\"a\":1,\"A\":2}","ebc9b8aa43f2b1a71c24114865a05055"],
  ["{\"a\":1,\"a \":2}","bb5a12d48a77b4451f22e50e596fe574"],
  ["{\"a\\\\\":1,\"a\":2}","3b5306d5f746308673bd8f303dc8ef7d"],
  ["{\"x\":{},\"y\":{}}","c67a62b2425e17ae822e765199a32e74"],
  ["{\"x\":[],\"x2\":[[{\"x\":1}]],\"x3\":{\"x\":1}}","90cc3c1f41e77c84484dca64475cef16"],
  ["{\"s\":\"\\\"a\\\":1,\\\"a\\\":2\"}","cc500b7b25f747a412cefbb4cd2f6992"],
  ["{\"\\u00e9\":1,\"e\\u0301\":2}","4f9944c8fde59e9153535b17c02afbcc"],
  [" { \"a\" : 1 , \"b\" : { \"a\" : 2 } } ","f0b220e1b9b466d60b8c457190231f88"],
];

describe("every body without a repeated key keeps its main hash (#270)", () => {
  for (const [body, hash] of PR267_HASHES) {
    it(`${body} -> ${hash}`, async () => {
      expect(await hashOf(body)).toBe(hash);
    });
  }
});
