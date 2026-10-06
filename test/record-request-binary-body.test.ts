/**
 * A binary body inside a `Request` reaches upstream byte for byte (#145).
 *
 * #93 stopped the recorder from re-sending a decoded `init.body`, and argued the
 * `Request` case was safe: "there `init?.body` is undefined anyway -- so
 * `bodyText` is exactly the right fallback". It is not. `bodyText` is the
 * UTF-8 *decoding* of the body, so the fallback replaced the Request's own
 * bytes with a string in which every non-UTF-8 byte is U+FFFD. Measured on
 * main (3b40bae), 8 PNG-ish bytes `89504e47fffe0080` arrived upstream as 16
 * bytes `efbfbd504e47efbfbdefbfbd00efbfbd` -- and the cassette recorded the
 * response to a request nobody made. The fallback is unnecessary: the body was
 * read from a *clone*, so the Request's own body is still unread.
 *
 * Real `fetch` against a local server that echoes the bytes it received, because
 * the defect is what reaches the wire.
 */
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, createRecorderFetch } from "../src/index.js";

const HOSTS = new Set(["127.0.0.1"]);
const PNGISH = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
let server: Server;
let base: string;
let dir: string;
let store: CassetteStore;

beforeEach(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ received: Buffer.concat(chunks).toString("hex") }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-binreq-"));
  store = new CassetteStore({ dir });
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(dir, { recursive: true, force: true });
});

const recorder = () => createRecorderFetch({ upstream: fetch, store, hosts: HOSTS });
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("a Request's own body is forwarded, not its decoding (#145)", () => {
  it("binary bytes in a Request arrive intact", async () => {
    const res = await recorder()(new Request(`${base}/v1/upload`, { method: "POST", body: PNGISH }));
    expect((await res.json()).received).toBe(hex(PNGISH));
  });

  it("the same bytes as init.body arrive intact (#93's control)", async () => {
    const res = await recorder()(`${base}/v1/upload`, { method: "POST", body: PNGISH });
    expect((await res.json()).received).toBe(hex(PNGISH));
  });

  it("a text body in a Request is unchanged", async () => {
    const body = JSON.stringify({ prompt: "héllo 😀" });
    const res = await recorder()(new Request(`${base}/v1/chat`, { method: "POST", body }));
    expect((await res.json()).received).toBe(Buffer.from(body, "utf8").toString("hex"));
  });

  it("init.body still wins over a Request's own body", async () => {
    const own = new Request(`${base}/v1/upload`, { method: "POST", body: "own" });
    const res = await recorder()(own, { method: "POST", body: PNGISH });
    expect((await res.json()).received).toBe(hex(PNGISH));
  });
});
