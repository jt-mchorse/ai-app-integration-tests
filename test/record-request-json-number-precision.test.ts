/**
 * A JSON number the parse loses is not hashed as the number it lost to (#264).
 *
 * `normalizeRequest` hashed a JSON body through `JSON.parse`, which reads every
 * number as a double: 9007199254740993 became 9007199254740992, and `1e400`
 * became Infinity, which serializes as `null`. Measured on main (ee87607),
 * `{"seed":...993}`, `{"seed":...992}`, `{"x":1e400}`, `{"x":null}` and
 * `{"x":-1e400}` recorded 2 cassettes for 5 requests, and replaying `...993`
 * served the `...992` response. A body holding an integer literal the double
 * cannot hold, or a literal that overflows, now hashes as its text under the
 * folded `raw` tag. Every other body keeps its hash, pinned below against main.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, MissingCassetteError, createRecorderFetch, createReplayerFetch } from "../src/index.js";

const HOSTS = new Set(["api.example.com"]);
const URL_ = "https://api.example.com/v1/x";
let dir: string;
let store: CassetteStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-jsonnum-"));
  store = new CassetteStore({ dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// Echoes the body it was sent, so a replay shows whose response it served.
const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) =>
  new Response(JSON.stringify({ echo: init?.body ?? null }), {
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

async function record(body: string | undefined): Promise<void> {
  const rec = createRecorderFetch({ upstream, store, hosts: HOSTS });
  await rec(URL_, body === undefined ? { method: "POST" } : { method: "POST", body });
}

async function replayEcho(body: string | undefined): Promise<unknown> {
  const rep = createReplayerFetch({ store, hosts: HOSTS });
  const r = await rep(URL_, body === undefined ? { method: "POST" } : { method: "POST", body });
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

// Each pair is two different requests to a server that reads integers exactly
// (int64, Python, BigInt) or refuses an overflow: `JSON.parse` made them one.
const COLLIDING_PAIRS: Array<[string, string, string]> = [
  ["int above 2^53 vs its double", '{"seed":9007199254740993}', '{"seed":9007199254740992}'],
  ["two ints above 2^54 that round to one double", '{"seed":18014398509481985}', '{"seed":18014398509481986}'],
  ["negative int below -2^53", '{"seed":-9007199254740993}', '{"seed":-9007199254740992}'],
  ["int64 max vs 2^63", '{"id":9223372036854775807}', '{"id":9223372036854775808}'],
  ["1e400 vs null", '{"x":1e400}', '{"x":null}'],
  ["1e400 vs -1e400", '{"x":1e400}', '{"x":-1e400}'],
  ["an overflowing literal written out", `{"x":${"9".repeat(400)}}`, '{"x":null}'],
  ["inside an array", '{"ids":[1,9007199254740993]}', '{"ids":[1,9007199254740992]}'],
  ["nested", '{"a":{"b":[{"c":12345678901234567}]}}', '{"a":{"b":[{"c":12345678901234568}]}}'],
  ["top-level number", "9007199254740993", "9007199254740992"],
  ["after a string with an escaped quote", '{"s":"\\"","n":9007199254740993}', '{"s":"\\"","n":9007199254740992}'],
];

describe("a number JSON.parse loses is its own cassette (#264)", () => {
  for (const [name, a, b] of COLLIDING_PAIRS) {
    it(`${name}: two cassettes, and each replays its own response`, async () => {
      await record(a);
      await record(b);
      expect(await cassettes()).toHaveLength(2);
      expect(await replayEcho(a)).toBe(a);
      expect(await replayEcho(b)).toBe(b);
    });
  }

  it("a top-level 1e400 body is not the no-body request", async () => {
    // Infinity serializes as `null` and is not `=== null`, so neither the
    // json-null fold (#70) nor anything else told it from a POST with no body.
    await record("1e400");
    await record(undefined);
    expect(await cassettes()).toHaveLength(2);
    expect(await replayEcho("1e400")).toBe("1e400");
    expect(await replayEcho(undefined)).toBe(null);
  });

  it("the cassette records the number as sent, not as the double", async () => {
    await record('{"seed":9007199254740993}');
    const [f] = await cassettes();
    const cassette = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
    expect(cassette.request.body).toBe('{"seed":9007199254740993}');
    expect(cassette.request.bodyEncoding).toBe("raw");
  });

  it("a raw (non-JSON) body spelling a similar text stays apart", async () => {
    // Raw bodies are text JSON.parse refuses; this one differs by a trailing
    // comma, and both carry the folded `raw` tag.
    await record('{"seed":9007199254740993}');
    await record('{"seed":9007199254740993,}');
    expect(await cassettes()).toHaveLength(2);
  });

  it("the same lossy body sent twice replays from one cassette", async () => {
    await record('{"seed":9007199254740993}');
    await record('{"seed":9007199254740993}');
    expect(await cassettes()).toHaveLength(1);
  });

  it("hashing by text: a reordered lossy body misses loudly instead of misserving", async () => {
    await record('{"a":1,"seed":9007199254740993}');
    const rep = createReplayerFetch({ store, hosts: HOSTS });
    await expect(rep(URL_, { method: "POST", body: '{"seed":9007199254740993,"a":1}' })).rejects.toBeInstanceOf(
      MissingCassetteError,
    );
  });
});

// Captured on main (ee87607) by recording each body through createRecorderFetch.
// Doubles keep double semantics, so equal doubles still share a hash.
const MAIN_HASHES: Array<[string, string]> = [
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
];

describe("every body JSON.parse holds exactly keeps its main hash (#264)", () => {
  for (const [body, hash] of MAIN_HASHES) {
    it(`${body} -> ${hash}`, async () => {
      expect(await hashOf(body)).toBe(hash);
    });
  }

  it("the pins include equal doubles spelled differently, and they still share a hash", () => {
    const byBody = new Map(MAIN_HASHES);
    for (const [x, y] of [
      ['{"n":1}', '{"n":1.0}'],
      ['{"n":100}', '{"n":1e2}'],
      ['{"n":0}', '{"n":-0}'],
      ['{"n":0}', '{"n":1e-400}'],
      ['{"n":1e21}', '{"n":1000000000000000000000}'],
      ['{"n":9007199254740992}', '{"n":9007199254740993.0}'],
    ]) {
      expect(byBody.get(x)).toBeDefined();
      expect(byBody.get(x)).toBe(byBody.get(y));
    }
  });
});
