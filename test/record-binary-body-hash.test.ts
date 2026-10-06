/**
 * Two different binary bodies are two cassettes (#147, D-015).
 *
 * Every byte-container body was decoded with a lenient `TextDecoder`, which maps
 * each invalid UTF-8 byte to U+FFFD, and the decoded string is the hash input.
 * Measured on main (3b40bae): `Int16Array([-1])` and `Int16Array([-2])`, or
 * `Uint8Array([0xff])` and `[0xfe]`, recorded to ONE cassette, and replaying the
 * first request served the second one's response. A fatal decoder now decides:
 * valid UTF-8 keeps its text -- and its hash, pinned below against main -- and
 * anything else hashes as base64 tagged `bodyEncoding: "base64"`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";

const HOSTS = new Set(["api.example.com"]);
const URL_ = "https://api.example.com/v1/x";
let dir: string;
let store: CassetteStore;
let calls: number;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-binhash-"));
  store = new CassetteStore({ dir });
  calls = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const upstream = (async () => {
  calls += 1;
  return new Response(JSON.stringify({ call: calls }), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

type Make = () => BodyInit | Request;

async function send(make: Make): Promise<void> {
  const rec = createRecorderFetch({ upstream, store, hosts: HOSTS });
  const b = make();
  await (b instanceof Request ? rec(b) : rec(URL_, { method: "POST", body: b }));
}

async function cassettes(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
}

const file = (bytes: number[]) => {
  const fd = new FormData();
  fd.append("upload", new Blob([new Uint8Array(bytes)]), "a.bin");
  return fd;
};

// Each pair differs only in bytes that are not valid UTF-8.
const PAIRS: [string, Make, Make][] = [
  ["ArrayBuffer", () => new Uint8Array([0xff]).buffer, () => new Uint8Array([0xfe]).buffer],
  ["Uint8Array", () => new Uint8Array([0xff]), () => new Uint8Array([0xfe])],
  ["Int16Array", () => new Int16Array([-1]), () => new Int16Array([-2])],
  ["DataView", () => new DataView(new Uint8Array([0x80]).buffer), () => new DataView(new Uint8Array([0x81]).buffer)],
  ["Blob", () => new Blob([new Uint8Array([0xff])]), () => new Blob([new Uint8Array([0xfe])])],
  [
    "Request",
    () => new Request(URL_, { method: "POST", body: new Uint8Array([0xff]) }),
    () => new Request(URL_, { method: "POST", body: new Uint8Array([0xfe]) }),
  ],
  ["FormData file", () => file([0xff]), () => file([0xfe])],
];

describe("binary bodies that are not UTF-8 do not collide (#147)", () => {
  it.each(PAIRS)("%s: two bodies, two cassettes, and replay serves each its own", async (_n, a, b) => {
    await send(a);
    await send(b);
    expect(await cassettes()).toHaveLength(2);
    const replay = createReplayerFetch({ store, hosts: HOSTS });
    const first = a();
    const res = await (first instanceof Request ? replay(first) : replay(URL_, { method: "POST", body: first }));
    expect((await res.json()).call).toBe(1);
  });

  it.each([
    ["a raw text body", "/w=="],
    // A JSON string canonicalizes to the bare string and its "json" tag is not
    // folded into the hash -- the forgery the "base64" tag has to be folded for.
    ["a JSON string body", JSON.stringify("/w==")],
  ])("%s spelling the same base64 is a different cassette", async (_n, text) => {
    // `[0xff]` hashes as base64 `/w==`; the tag lives outside the body.
    await send(() => new Uint8Array([0xff]));
    await send(() => text);
    expect(await cassettes()).toHaveLength(2);
  });
});

describe("every valid-UTF-8 body keeps the hash main gave it", () => {
  // Captured from main (3b40bae) by recording each body and reading the file
  // name, which is `<requestHash>.json`. Any change here re-keys cassettes
  // users have already committed.
  const fd = () => {
    const f = new FormData();
    f.append("note", "hi");
    f.append("file", new Blob(["file-text"], { type: "text/plain" }), "a.txt");
    return f;
  };
  const PINNED: [string, Make, string][] = [
    ["string", () => "hello", "fc3dc67e8155020caf37464a0c220321"],
    ["ArrayBuffer", () => new TextEncoder().encode("héllo").buffer, "2db1f3a0ea2dfa5d7ede2709033f64ad"],
    ["Uint8Array", () => new TextEncoder().encode("héllo"), "2db1f3a0ea2dfa5d7ede2709033f64ad"],
    ["Int16Array", () => new Int16Array([0x6968]), "cc031470d1203aa6fd05ea8830a1aaba"],
    ["DataView", () => new DataView(new TextEncoder().encode("dv").buffer), "399716df4a6924762aff6aa62243fe50"],
    ["Blob", () => new Blob(["blob-payload"]), "7d658c36bd60faecca77246ecefbc7f5"],
    ["FormData", fd, "b7cfafd3d96a888db0c30c0e5a6af775"],
    [
      "Request",
      () => new Request(URL_, { method: "POST", body: "from-request" }),
      "a7b6af63198df39a9764221d1d38c44e",
    ],
  ];

  it.each(PINNED)("%s", async (_n, make, hash) => {
    await send(make);
    expect(await cassettes()).toEqual([`${hash}.json`]);
  });
});
