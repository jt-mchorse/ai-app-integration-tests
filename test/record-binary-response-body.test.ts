/**
 * A response body is recorded and replayed as its bytes (#173).
 *
 * The recorder read a non-streaming response with `.text()`, a lenient UTF-8
 * decode that maps every invalid byte to U+FFFD. Measured on main: an upstream
 * that sent `89504e47...ff00fe` handed the record-mode caller
 * `efbfbd504e47...efbfbd00efbfbd`, and every replay served the same. The README
 * promises the replayer serves responses "back byte-for-byte". A strict decoder
 * now decides how the body is stored (text when it is UTF-8, base64 tagged
 * `bodyEncoding: "base64"` otherwise), the request-side rule of D-015.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";
import type { CassetteV1 } from "../src/cassette.js";

const HOSTS = new Set(["api.anthropic.com"]);
const URL_ = "https://api.anthropic.com/v1/files/file_abc/content";
let dir: string;
let store: CassetteStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-binresp-"));
  store = new CassetteStore({ dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const hex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as Uint8Array).toString("hex");
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));

function upstreamOf(bytes: number[], contentType: string): typeof fetch {
  return (async () =>
    new Response(new Uint8Array(bytes), { headers: { "content-type": contentType } })) as typeof fetch;
}

async function onlyCassette(): Promise<CassetteV1> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(await fs.readFile(path.join(dir, files[0]), "utf8")) as CassetteV1;
}

// [label, bytes, stored as base64?]
const BODIES: Array<[string, number[], boolean]> = [
  ["a PNG header plus non-UTF-8 bytes", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe], true],
  ["a lone 0xff", [0xff], true],
  ["a lone continuation byte", [0x80], true],
  ["a truncated 3-byte sequence", [0x41, 0xe2, 0x82], true],
  ["a UTF-8 BOM before text", [0xef, 0xbb, 0xbf, ...utf8("A")], false],
  ["UTF-8 JSON with non-ASCII", utf8('{"text":"héllo — 世界"}'), false],
];

describe("non-streaming response bytes", () => {
  it.each(BODIES)("%s reaches the record-mode caller unchanged", async (_label, bytes) => {
    const rec = createRecorderFetch({ upstream: upstreamOf(bytes, "application/octet-stream"), store, hosts: HOSTS });
    const r = await rec(URL_);
    expect(hex(await r.arrayBuffer())).toBe(hex(new Uint8Array(bytes)));
  });

  it.each(BODIES)("%s replays byte-for-byte", async (_label, bytes) => {
    await createRecorderFetch({ upstream: upstreamOf(bytes, "application/octet-stream"), store, hosts: HOSTS })(URL_);
    const r = await createReplayerFetch({ store, hosts: HOSTS })(URL_);
    expect(hex(await r.arrayBuffer())).toBe(hex(new Uint8Array(bytes)));
  });

  it.each(BODIES)("%s is stored as text unless it is not UTF-8", async (_label, bytes, base64) => {
    await createRecorderFetch({ upstream: upstreamOf(bytes, "application/octet-stream"), store, hosts: HOSTS })(URL_);
    const c = await onlyCassette();
    if (c.response.kind !== "non_streaming") throw new Error("expected non_streaming");
    if (base64) {
      expect(c.response.bodyEncoding).toBe("base64");
      expect(c.response.body).toBe(Buffer.from(bytes).toString("base64"));
    } else {
      // A UTF-8 body keeps the shape every committed cassette already has: the
      // text, and no `bodyEncoding` key at all.
      expect("bodyEncoding" in c.response).toBe(false);
      expect(new TextEncoder().encode(c.response.body)).toEqual(new Uint8Array(bytes));
    }
  });

  it("a JSON response's cassette is unchanged: the plain text, no new key", async () => {
    const text = '{"id":"msg_1","content":[{"type":"text","text":"20"}]}';
    await createRecorderFetch({ upstream: upstreamOf(utf8(text), "application/json"), store, hosts: HOSTS })(URL_);
    const c = await onlyCassette();
    expect(c.response).toEqual({
      kind: "non_streaming",
      status: 200,
      headers: { "content-type": "application/json" },
      body: text,
    });
  });
});

describe("CassetteStore.read and response.bodyEncoding", () => {
  async function writeRaw(bodyEncoding: unknown): Promise<string> {
    await createRecorderFetch({ upstream: upstreamOf([0xff], "application/octet-stream"), store, hosts: HOSTS })(URL_);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    const p = path.join(dir, files[0]);
    const c = JSON.parse(await fs.readFile(p, "utf8"));
    c.response.bodyEncoding = bodyEncoding;
    await fs.writeFile(p, JSON.stringify(c));
    return c.request_hash as string;
  }

  it.each([["hex"], ["raw"], [""], [1], [null]])(
    "refuses bodyEncoding %j rather than replaying the stored text as the bytes",
    async (value) => {
      const hash = await writeRaw(value);
      await expect(store.read(hash)).rejects.toThrow(/bodyEncoding/);
    },
  );

  it("accepts \"base64\"", async () => {
    const hash = await writeRaw("base64");
    await expect(store.read(hash)).resolves.not.toBeNull();
  });
});
