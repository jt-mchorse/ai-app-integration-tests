/**
 * The leak scanner reads a base64-stored body as the bytes it encodes (#175).
 *
 * #147 (requests) and #173 (responses) store a body that is not valid UTF-8 as
 * base64, tagged `bodyEncoding: "base64"`. `assertNoLeakedSecrets` scanned
 * `JSON.stringify(cassette)`, i.e. the base64 text. Measured on main through
 * `createRecorderFetch`, with the same key in each body and "non-utf8" meaning
 * the text prefixed with byte 0xff:
 *
 *   utf8 response echoing key      : REFUSED
 *   non-utf8 response echoing key  : WRITTEN, base64-decoded body has the key
 *   utf8 request body with key     : REFUSED
 *   non-utf8 request body with key : WRITTEN, base64-decoded body has the key
 *
 * and the committed-cassette rescan (#171), which calls the same function,
 * passed such a cassette.
 */
import { spawnSync } from "node:child_process";
import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertNoLeakedSecrets, type CassetteV1 } from "../src/cassette.js";
import { CassetteStore, createRecorderFetch } from "../src/index.js";

const KEY = `sk-ant-api03-${"A".repeat(92)}`;
const HOSTS = new Set(["api.anthropic.com"]);
const URL_ = "https://api.anthropic.com/v1/files";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const nonUtf8 = (text: string) => new Uint8Array([0xff, ...new TextEncoder().encode(text)]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function cassette(over: { reqBody?: string; respBody?: string }): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "0".repeat(32),
    request: {
      method: "POST",
      url: URL_,
      headers: {},
      body: over.reqBody ?? "ok",
      bodyEncoding: over.reqBody === undefined ? "raw" : "base64",
    },
    response: {
      kind: "non_streaming",
      status: 200,
      headers: {},
      body: over.respBody ?? "ok",
      ...(over.respBody === undefined ? {} : { bodyEncoding: "base64" as const }),
    },
    recorded_at: "2026-10-09T00:00:00.000Z",
  } as CassetteV1;
}

describe("assertNoLeakedSecrets on base64-stored bodies", () => {
  it("refuses a key inside a base64 request body, naming the request body", () => {
    expect(() => assertNoLeakedSecrets(cassette({ reqBody: b64(nonUtf8(`k=${KEY}`)) }))).toThrow(
      /unredacted secret .* in the request body/,
    );
  });

  it("refuses a key inside a base64 response body, naming the response", () => {
    expect(() => assertNoLeakedSecrets(cassette({ respBody: b64(nonUtf8(`echo ${KEY}`)) }))).toThrow(
      /unredacted secret .* in the response/,
    );
  });

  it.each([
    ["an api-key query-style pair", `api-key=${"0123456789abcdef".repeat(2)}`],
    ["a Bearer token", `Authorization: Bearer ${"A".repeat(18)}==`],
    ["a Google key", `AIza${"B".repeat(35)}`],
  ])("refuses %s inside binary bytes", (_label, secret) => {
    expect(() => assertNoLeakedSecrets(cassette({ respBody: b64(nonUtf8(` ${secret} `)) }))).toThrow(
      /unredacted secret/,
    );
  });

  it("writes a binary body with no credential in its bytes", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);
    expect(() => assertNoLeakedSecrets(cassette({ reqBody: b64(png), respBody: b64(png) }))).not.toThrow();
  });

  it("does not refuse bytes whose base64 merely LOOKS like a key", () => {
    // `AIza` + 36 `B`s is valid base64; its bytes are binary noise, not a key.
    const text = `AIza${"B".repeat(36)}`;
    expect(Buffer.from(Buffer.from(text, "base64")).toString("base64")).toBe(text);
    expect(() => assertNoLeakedSecrets(cassette({ respBody: text }))).not.toThrow();
  });
});

describe("through the recorder", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-b64scan-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function record(reqBody: Uint8Array, respBody: Uint8Array) {
    const upstream = (async () =>
      new Response(respBody, { headers: { "content-type": "application/octet-stream" } })) as typeof fetch;
    const rec = createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
    await rec(URL_, { method: "POST", body: reqBody, headers: { "content-type": "application/octet-stream" } });
  }
  const written = async () => (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));

  it("refuses to write a non-UTF-8 response that echoes the key", async () => {
    await expect(record(new TextEncoder().encode("ok"), nonUtf8(`echo ${KEY}`))).rejects.toThrow(/unredacted secret/);
    expect(await written()).toEqual([]);
  });

  it("refuses to write a non-UTF-8 request body that carries the key", async () => {
    await expect(record(nonUtf8(`k=${KEY}`), new TextEncoder().encode("ok"))).rejects.toThrow(/unredacted secret/);
    expect(await written()).toEqual([]);
  });
});

describe("the committed-cassette rescan (#171)", () => {
  const tmp: string[] = [];
  afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("fails on a committed cassette whose base64 body holds a key", () => {
    const fixtures = mkdtempSync(path.join(os.tmpdir(), "aiit-b64rescan-"));
    tmp.push(fixtures);
    writeFileSync(path.join(fixtures, "leak.json"), JSON.stringify(cassette({ respBody: b64(nonUtf8(KEY)) })));
    const out = spawnSync("npx", ["tsx", path.join(REPO_ROOT, "scripts", "scan-committed-cassettes.ts"), fixtures], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(out.status, out.stderr).toBe(1);
    expect(out.stdout + out.stderr).toMatch(/leak\.json/);
  });
});
