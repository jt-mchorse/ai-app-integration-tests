/**
 * A body marked base64 that is not base64 is scanned as the text it holds (#193).
 *
 * `scanView` (#175) replaces each `bodyEncoding: "base64"` body with its decoded
 * bytes. Node's decoder skips every character outside the base64 alphabet, so
 * for a hand-edited cassette whose "base64" body is really text, the decode
 * threw that text away -- a cleartext key included -- and the committed-cassette
 * rescan (#171), whose stated population is hand-edited cassettes, passed a
 * file that literally contained the key. Canonical base64 still reads as its
 * bytes only; `leak-scanner-base64-bodies.test.ts` pins that side.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { assertNoLeakedSecrets, type CassetteV1 } from "../src/cassette.js";

const KEY = "sk-ant-api03-" + "Ab3dEfGh1jKlMn0pQrStUvWxYz012345678";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function cassette(over: { reqBody?: string; respBody?: string }): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "0".repeat(32),
    request: {
      method: "POST",
      url: "https://api.anthropic.com/v1/files",
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
    recorded_at: "2026-10-13T00:00:00.000Z",
  } as CassetteV1;
}

const REFUSE: Array<[string, CassetteV1, string]> = [
  ["a JSON response body marked base64", cassette({ respBody: `{"echo":"${KEY}"}` }), "the response"],
  ["a bare key as a response body marked base64", cassette({ respBody: KEY }), "the response"],
  ["a request body marked base64", cassette({ reqBody: `k=${KEY}` }), "the request body"],
];

const ALLOW: Array<[string, CassetteV1]> = [
  // Canonical base64 reads as its bytes only (#175's lock, restated here).
  ["canonical base64 that merely LOOKS like a key", cassette({ respBody: `AIza${"B".repeat(36)}` })],
  ["unpadded base64 text with no key in it", cassette({ respBody: "aGVsbG8" })],
  ["a non-base64 body with no key in it", cassette({ reqBody: "hello world!!", respBody: "not base64 at all" })],
];

describe("a body marked base64 that is not base64 (#193)", () => {
  it.each(REFUSE)("refuses: %s", (_name, c, where) => {
    expect(() => assertNoLeakedSecrets(c)).toThrow(new RegExp(`unredacted secret.* in ${where}`));
  });

  it.each(ALLOW)("allows: %s", (_name, c) => {
    expect(() => assertNoLeakedSecrets(c)).not.toThrow();
  });

  it("still refuses a key in the bytes of canonical base64 (control)", () => {
    const body = Buffer.from(`echo ${KEY}`).toString("base64");
    expect(() => assertNoLeakedSecrets(cassette({ respBody: body }))).toThrow(/in the response/);
  });
});

describe("the committed-cassette rescan (#171)", () => {
  const tmp: string[] = [];
  afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("fails on a committed cassette with a cleartext key in a body marked base64", () => {
    const fixtures = mkdtempSync(path.join(os.tmpdir(), "aiit-193-"));
    tmp.push(fixtures);
    writeFileSync(path.join(fixtures, "leak.json"), JSON.stringify(cassette({ respBody: `{"echo":"${KEY}"}` })));
    const out = spawnSync("npx", ["tsx", path.join(REPO_ROOT, "scripts", "scan-committed-cassettes.ts"), fixtures], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(out.status, out.stderr).toBe(1);
    expect(out.stdout + out.stderr).toMatch(/leak\.json/);
  });
});
