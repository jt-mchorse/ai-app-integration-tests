/**
 * A leading UTF-8 BOM is part of a request body's bytes (#195).
 *
 * `readBytes` decoded with a fatal `TextDecoder` whose `ignoreBOM` was left
 * false, so it dropped a leading `EF BB BF`: a body with and without one read
 * as one text, hashed to one cassette, and replaying the first served the
 * second's response -- the #147 collision class (D-015). Measured on main
 * (6f3db44): `[EF BB BF 61 62 63]` then `[61 62 63]` recorded one cassette and
 * the replay of the first returned the second's response. It also split a
 * string body from its own UTF-8 bytes: `"﻿abc"` kept the BOM, its bytes
 * did not, so recording one shape and replaying the other missed.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";

const HOSTS = new Set(["api.example.com"]);
const URL_ = "https://api.example.com/v1/x";
// Built from code points, not a literal: an editor or a round trip can strip it.
const BOM = String.fromCodePoint(0xfeff);
const ABC = [0x61, 0x62, 0x63];
const WITH_BOM = [0xef, 0xbb, 0xbf, ...ABC];

let dir: string;
let store: CassetteStore;
let calls: number;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-bom-"));
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

type Make = (bytes: number[]) => BodyInit | Request;

async function send(body: BodyInit | Request, f: typeof fetch): Promise<Response> {
  return body instanceof Request ? f(body) : f(URL_, { method: "POST", body });
}

async function cassettes(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
}

// Every body shape that reaches `readBytes`.
const SHAPES: [string, Make][] = [
  ["ArrayBuffer", (b) => new Uint8Array(b).buffer],
  ["Uint8Array", (b) => new Uint8Array(b)],
  ["DataView", (b) => new DataView(new Uint8Array(b).buffer)],
  ["Blob", (b) => new Blob([new Uint8Array(b)])],
  ["Request", (b) => new Request(URL_, { method: "POST", body: new Uint8Array(b) })],
  [
    "FormData file",
    (b) => {
      const fd = new FormData();
      fd.append("upload", new Blob([new Uint8Array(b)]), "a.txt");
      return fd;
    },
  ],
];

describe("a body with and without a leading BOM are two cassettes (#195)", () => {
  it.each(SHAPES)("%s: replay serves each its own response", async (_n, make) => {
    const rec = createRecorderFetch({ upstream, store, hosts: HOSTS });
    await send(make(WITH_BOM), rec);
    await send(make(ABC), rec);
    expect(await cassettes()).toHaveLength(2);

    const replay = createReplayerFetch({ store, hosts: HOSTS });
    expect((await (await send(make(WITH_BOM), replay)).json()).call).toBe(1);
    expect((await (await send(make(ABC), replay)).json()).call).toBe(2);
  });

  it("the BOM survives into the recorded body text", async () => {
    const rec = createRecorderFetch({ upstream, store, hosts: HOSTS });
    await send(new Uint8Array(WITH_BOM), rec);
    const [file] = await cassettes();
    const cassette = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
    expect(cassette.request.body).toBe(`${BOM}abc`);
    expect(cassette.request.bodyEncoding).toBe("raw");
  });
});

describe("a string body and its UTF-8 bytes hash alike, BOM included (#195)", () => {
  it.each(SHAPES.filter(([n]) => n !== "FormData file"))(
    "recorded as a string, replayed as %s",
    async (_n, make) => {
      const rec = createRecorderFetch({ upstream, store, hosts: HOSTS });
      await send(`${BOM}abc`, rec);
      const replay = createReplayerFetch({ store, hosts: HOSTS });
      expect((await (await send(make(WITH_BOM), replay)).json()).call).toBe(1);
    },
  );
});
