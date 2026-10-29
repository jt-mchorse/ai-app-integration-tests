/**
 * A non-UTF-8 query escape keeps its bytes in the cassette URL (#265).
 *
 * `normalizeUrl` rebuilt the query from `searchParams`, which decodes a
 * non-UTF-8 escape to U+FFFD, and `append` wrote that back as `%EF%BF%BD`. So
 * `?s=%FF`, `?s=%FE` and `?s=%EF%BF%BD` were one cassette: the recorder
 * overwrote one with the other and replay served the wrong response. This is
 * the URL half of #147, which fixed the same collision for bodies.
 *
 * The hash table below was captured from origin/main 9c79c76 before the fix.
 * Every URL in it is valid UTF-8, so its cassette must not move.
 */
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashRequest, normalizeUrl } from "../src/cassette.js";
import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";

const getHash = (url: string) => hashRequest({ method: "GET", url: normalizeUrl(url), headers: {}, body: null });

// [input, normalizeUrl on origin/main, hashRequest of a GET on origin/main]
const PINNED: ReadonlyArray<[string, string, string]> = [
  ["https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/messages", "20eb0507c704435d0add92116dba76cd"],
  ["https://api.anthropic.com/v1/messages?a=1&b=2", "https://api.anthropic.com/v1/messages?a=1&b=2", "55fa7c729819eafabc15c761d44641bf"],
  ["https://api.anthropic.com/v1/messages?b=2&a=1", "https://api.anthropic.com/v1/messages?a=1&b=2", "55fa7c729819eafabc15c761d44641bf"],
  ["https://x/y?tag=b&tag=a", "https://x/y?tag=a&tag=b", "62fd2b303fdf57430843bed460153fd4"],
  ["https://x/y?tag=a&tag=b&tag=a", "https://x/y?tag=a&tag=a&tag=b", "913af8d898181b85e5027ec1883b5b83"],
  ["https://x/q?s=a+b", "https://x/q?s=a+b", "633743983ed5aea12d9adabe7086e272"],
  ["https://x/q?s=a%20b", "https://x/q?s=a+b", "633743983ed5aea12d9adabe7086e272"],
  ["https://x/q?s=a b", "https://x/q?s=a+b", "633743983ed5aea12d9adabe7086e272"],
  ["https://x/q?s=%C3%A9", "https://x/q?s=%C3%A9", "da09d8db0a3ed4e2143fae0f65dd922f"],
  ["https://x/q?s=%c3%a9", "https://x/q?s=%C3%A9", "da09d8db0a3ed4e2143fae0f65dd922f"],
  ["https://x/q?s=é", "https://x/q?s=%C3%A9", "da09d8db0a3ed4e2143fae0f65dd922f"],
  ["https://x/q?s=%E2%82%AC&n=%F0%9F%98%80", "https://x/q?n=%F0%9F%98%80&s=%E2%82%AC", "bb2dfa8a1840e51ec6df4706d25c9e27"],
  ["https://x/q?s=%EF%BF%BD", "https://x/q?s=%EF%BF%BD", "e81320d6ff53aa7f771e7fb40c0c35dc"],
  ["https://x/q?%EF%BB%BFa=1", "https://x/q?%EF%BB%BFa=1", "63d6baa6c7bd67671a570e68999c217c"],
  ["https://x/q?s=", "https://x/q?s=", "2951d763b96ce3810a41e294262b8c26"],
  ["https://x/q?flag", "https://x/q?flag=", "446414567f81d6053ed5c48a0033853d"],
  ["https://x/q?flag&a=1", "https://x/q?a=1&flag=", "d6144b03ef2723b3a5042a737f11a2be"],
  ["https://x/q?=v", "https://x/q?=v", "c0b52367323090afe7c6921f9d8510ed"],
  ["https://x/q?", "https://x/q", "697b0c8a860e11a278c87fff3c67e8f3"],
  ["https://x/q?&&a=1&&", "https://x/q?a=1", "8ac6fe6d1c49a238045aafa1cbfa4f3b"],
  ["https://x/q?a=1=2", "https://x/q?a=1%3D2", "7b9e0028e8dd73e988ad75dbfc7ab6be"],
  ["https://x/q?s=%2B%26%3D%23", "https://x/q?s=%2B%26%3D%23", "bd53031a9d2da7b2de3e380338f2d614"],
  ["https://x/q?s=%", "https://x/q?s=%25", "ad3d9333d4154133b54da50cfe2aea42"],
  ["https://x/q?s=%zz", "https://x/q?s=%25zz", "55815fb67d62df6050d4550b68bb0597"],
  ["https://x/q?s=*-._~!'()", "https://x/q?s=*-._%7E%21%27%28%29", "6cf8560a479502aec6082d6533163538"],
  ["https://x/q?model=4&a=1&Z=3&Beta=2", "https://x/q?Beta=2&Z=3&a=1&model=4", "604ffa9ce03227941135332792634f2d"],
  ["https://u:p@x/q?b=1&a=2#frag", "https://x/q?a=2&b=1", "ebeb9707896323304ebfff7e3e11a97b"],
  ["https://x/%E2%82%AC/v1?k=%41", "https://x/%E2%82%AC/v1?k=A", "8ac4093b580377727e366424a7f10583"],
];

describe("existing URL hashes are byte-identical (#265)", () => {
  it.each(PINNED)("%s", (input, normalized, hash) => {
    expect(normalizeUrl(input)).toBe(normalized);
    expect(getHash(input)).toBe(hash);
  });
});

describe("non-UTF-8 query escapes keep their bytes (#265)", () => {
  it.each([
    ["value", "https://x/q?s=%FF", "https://x/q?s=%FE"],
    ["name", "https://x/q?%FF=1", "https://x/q?%FE=1"],
    ["a lone lead byte", "https://x/q?s=%C3", "https://x/q?s=%C4"],
    ["a Latin-1 byte", "https://x/q?s=%E9", "https://x/q?s=%E8"],
    ["an encoded surrogate", "https://x/q?s=%ED%A0%80", "https://x/q?s=%ED%A0%81"],
    ["a bare name", "https://x/q?%FF", "https://x/q?%FE"],
  ])("two %s escapes are two cassettes", (_label, a, b) => {
    expect(getHash(a)).not.toBe(getHash(b));
  });

  it("a non-UTF-8 escape is not the literal U+FFFD it used to become", () => {
    expect(normalizeUrl("https://x/q?s=%FF")).toBe("https://x/q?s=%FF");
    expect(getHash("https://x/q?s=%FF")).not.toBe(getHash("https://x/q?s=%EF%BF%BD"));
  });

  it("the written pair is the bytes, in the same encoding URLSearchParams uses", () => {
    expect(normalizeUrl("https://x/q?s=%ff")).toBe("https://x/q?s=%FF");
    expect(normalizeUrl("https://x/q?s=%FF+a")).toBe("https://x/q?s=%FF+a");
    expect(normalizeUrl("https://x/q?s=%FF%20a")).toBe("https://x/q?s=%FF+a");
    expect(normalizeUrl("https://x/q?s=%FF%")).toBe("https://x/q?s=%FF%25");
    expect(normalizeUrl("https://x/q?s=%FF%C3%A9~")).toBe("https://x/q?s=%FF%C3%A9%7E");
  });

  it("repeated non-UTF-8 values sort, so order does not matter", () => {
    expect(normalizeUrl("https://x/q?s=%FF&s=%FE")).toBe("https://x/q?s=%FE&s=%FF");
    expect(getHash("https://x/q?s=%FE&s=%FF")).toBe(getHash("https://x/q?s=%FF&s=%FE"));
  });

  it("a non-UTF-8 pair sorts among ordinary pairs by its decoded name", () => {
    expect(normalizeUrl("https://x/q?t=1&s=%FF&a=2")).toBe("https://x/q?a=2&s=%FF&t=1");
  });

  it("a non-UTF-8 pair beside its U+FFFD spelling sorts the same either way", () => {
    expect(normalizeUrl("https://x/q?s=%EF%BF%BD&s=%FF")).toBe(normalizeUrl("https://x/q?s=%FF&s=%EF%BF%BD"));
  });

  it("the path keeps its escapes (control: never decoded)", () => {
    expect(normalizeUrl("https://x/%FF/a")).toBe("https://x/%FF/a");
    expect(getHash("https://x/%FF/a")).not.toBe(getHash("https://x/%FE/a"));
  });

  it("the fragment is still dropped (control: #56)", () => {
    expect(normalizeUrl("https://x/q?s=1#%FF")).toBe(normalizeUrl("https://x/q?s=1#%FE"));
  });
});

describe("recorder and replayer keep ?s=%FF and ?s=%FE apart (#265)", () => {
  const HOSTS = new Set(["127.0.0.1"]);
  let server: Server;
  let base: string;
  let dir: string;
  let store: CassetteStore;

  beforeEach(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: req.url }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-q265-"));
    store = new CassetteStore({ dir });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("records two cassettes and replays each one's own response", async () => {
    const record = createRecorderFetch({ upstream: fetch, store, hosts: HOSTS });
    await record(`${base}/v1/q?s=%FF`);
    await record(`${base}/v1/q?s=%FE`);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(2);

    const replay = createReplayerFetch({ store, hosts: HOSTS });
    expect(await (await replay(`${base}/v1/q?s=%FF`)).json()).toEqual({ url: "/v1/q?s=%FF" });
    expect(await (await replay(`${base}/v1/q?s=%FE`)).json()).toEqual({ url: "/v1/q?s=%FE" });
  });
});
