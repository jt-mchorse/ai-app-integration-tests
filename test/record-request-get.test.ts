/**
 * A GET/HEAD passed as a `Request` records, and shares a cassette with `fetch(url)` (#143).
 *
 * `readBodyAsText` read a bodyless `Request` as "" via `clone().text()`. The
 * recorder then re-sent `body: ""` with method GET -- real fetch throws
 * "Request with GET/HEAD method cannot have body" -- and hashed "" where
 * `fetch(url)` hashes null, so the two call shapes were two cassettes.
 * These use real `fetch` against a local server, because the TypeError is
 * fetch's own and a stub upstream would not raise it.
 */
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";

const HOSTS = new Set(["127.0.0.1"]);
let server: Server;
let base: string;
let dir: string;
let store: CassetteStore;

beforeEach(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, method: req.method, body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-get-"));
  store = new CassetteStore({ dir });
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(dir, { recursive: true, force: true });
});

const recorder = () => createRecorderFetch({ upstream: fetch, store, hosts: HOSTS });

describe("bodyless Request inputs (#143)", () => {
  it.each(["GET", "HEAD"])("a %s Request records instead of throwing", async (method) => {
    const res = await recorder()(new Request(`${base}/v1/models`, { method }));
    expect(res.status).toBe(200);
  });

  it("fetch(url) and fetch(new Request(url)) share one cassette", async () => {
    await recorder()(`${base}/v1/models`);
    await recorder()(new Request(`${base}/v1/models`));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
  });

  it("a Request replays from a cassette recorded with a URL", async () => {
    await recorder()(`${base}/v1/models`);
    const replayed = await createReplayerFetch({ store, hosts: HOSTS })(new Request(`${base}/v1/models`));
    expect(await replayed.json()).toMatchObject({ ok: true, method: "GET" });
  });

  it("a POST Request still forwards its body (control)", async () => {
    const res = await recorder()(new Request(`${base}/v1/messages`, { method: "POST", body: "from-request" }));
    expect(await res.json()).toMatchObject({ method: "POST", body: "from-request" });
  });
});
