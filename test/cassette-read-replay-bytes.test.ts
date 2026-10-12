/**
 * `CassetteStore.read` refuses a cassette that would replay as wrong bytes (#189).
 *
 * The guard checked `frames` was an array and `bodyEncoding` was "base64" or
 * absent, not what was inside: `[42, null, {"a":1}]` replayed as
 * `42null[object Object]`, and a non-base64 "base64" body was silently decoded
 * to different bytes (Node's decoder skips characters outside the alphabet).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CassetteStore } from "../src/io.js";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

async function readWith(response: unknown): Promise<unknown> {
  dir = mkdtempSync(join(tmpdir(), "aiapp-189-"));
  const cassette = {
    schema_version: "1",
    request_hash: "h1",
    request: { method: "GET", url: "https://x/y", headers: {}, body: null },
    response,
    recorded_at: "2026-10-12T00:00:00Z",
  };
  writeFileSync(join(dir, "h1.json"), JSON.stringify(cassette));
  return new CassetteStore({ dir }).read("h1");
}

const sse = (frames: unknown[]) => ({ kind: "sse", status: 200, headers: {}, frames });
const b64 = (body: string) => ({
  kind: "non_streaming",
  status: 200,
  headers: {},
  body,
  bodyEncoding: "base64",
});

describe("CassetteStore.read refuses what would replay as wrong bytes (#189)", () => {
  it.each([[[42]], [[null]], [[{ a: 1 }]], [["data: ok\n\n", 7]]])(
    "a non-string SSE frame: %j",
    async (frames) => {
      await expect(readWith(sse(frames))).rejects.toThrow(/frames\[\d+\] must be a string/);
    },
  );

  it.each(["hello world!!", "aGVsbG8", "aGVs bG8=", "-_8=", "aGVsbG8==="])(
    "a body marked base64 that is not canonical base64: %j",
    async (body) => {
      await expect(readWith(b64(body))).rejects.toThrow(/not canonical base64/);
    },
  );

  it("still reads what the recorder writes", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x0a]);
    const ok = (await readWith(b64(bytes.toString("base64")))) as { response: { body: string } };
    expect(Buffer.from(ok.response.body, "base64").equals(bytes)).toBe(true);
    await expect(readWith(b64(""))).resolves.toBeTruthy();
    await expect(readWith(sse(["data: a\n\n", "data: b\n\n"]))).resolves.toBeTruthy();
  });
});
