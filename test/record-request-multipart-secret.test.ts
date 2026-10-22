/**
 * A credential field in a multipart body the recorder keeps as wire bytes is
 * refused before the live call (#243, follow-up to #231/#235).
 *
 * #231 parses undici's own FormData serialization back into records, and #235
 * keeps that parse only when it round-trips. A FormData `Request` holding a
 * File with an empty filename does not round-trip (undici writes the part with
 * no `filename=`, and the parse reads it back as a string field), so it fell
 * back to the byte read. There the field reads `name="api_key"`, a blank line
 * and the value, which no `key=` pattern matches: the key was sent live and
 * written. Every hand-built multipart body has the same shape. The scanner now
 * reads each part as `name=value`.
 *
 * Every REFUSE row went live and was written on `main` (b7d4734), Node 25.5 and
 * Node 20.9, except the file-before-field row, which only Node 20's parser
 * (the one CI runs) fails to round-trip. The controls were already refused or
 * have to stay accepted.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";
import { CassetteStore, createRecorderFetch } from "../src/index.js";

// No prefix of its own (an Azure `api-key`, an OAuth token): only the field
// name marks it, as in #223. Built from parts so this file is not a leak.
const FAKE_OPAQUE = ["fake", "opaque", "z".repeat(24)].join("");
const HOSTS = new Set(["api.example.com"]);
const URL_ = "https://api.example.com/v1/files";
const BOUNDARY = "fixedboundary243";
const HEADERS = { "content-type": `multipart/form-data; boundary=${BOUNDARY}` };

let dir: string;
let calls: number;

function recorder() {
  const upstream = (async () => {
    calls += 1;
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
}

async function written(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
}

/** A hand-built multipart body: one part per `[name, value]`, CRLF or LF. */
function multipart(fields: Array<readonly [string, string]>, eol = "\r\n"): string {
  const parts = fields.map(
    ([name, value]) => `--${BOUNDARY}${eol}Content-Disposition: form-data; name="${name}"${eol}${eol}${value}${eol}`,
  );
  return `${parts.join("")}--${BOUNDARY}--${eol}`;
}

/** An `api_key` field plus a file part that is not valid UTF-8, so the body is stored base64. */
function binaryMultipart(): Uint8Array {
  const head = Buffer.from(
    multipart([["api_key", FAKE_OPAQUE]]).replace(`--${BOUNDARY}--\r\n`, "") +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  return new Uint8Array(Buffer.concat([head, Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]));
}

function form(...entries: Array<readonly [string, string | File]>): FormData {
  const fd = new FormData();
  for (const [name, value] of entries) fd.append(name, value);
  return fd;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-mp-secret-"));
  calls = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a credential field in a multipart byte read is refused before the live call (#243)", () => {
  it.each([
    [
      "a FormData Request with an empty-filename File",
      () => new Request(URL_, { method: "POST", body: form(["api_key", FAKE_OPAQUE], ["file", new File(["x"], "")]) }),
    ],
    [
      "a FormData Request with a File before the field (Node 20's parser reorders it)",
      () =>
        new Request(URL_, {
          method: "POST",
          body: form(["file", new File(["x"], "a.txt")], ["access_token", FAKE_OPAQUE]),
        }),
    ],
    [
      "a hand-built multipart Request",
      () => new Request(URL_, { method: "POST", headers: HEADERS, body: multipart([["api_key", FAKE_OPAQUE]]) }),
    ],
    [
      "a hand-built multipart Request whose key is not the first field",
      () =>
        new Request(URL_, {
          method: "POST",
          headers: HEADERS,
          body: multipart([["purpose", "batch"], ["api_key", FAKE_OPAQUE]]),
        }),
    ],
    [
      "a hand-built multipart body with LF line endings",
      () => new Request(URL_, { method: "POST", headers: HEADERS, body: multipart([["api_key", FAKE_OPAQUE]], "\n") }),
    ],
    [
      "a multipart Request stored as base64 (a binary file part)",
      () => new Request(URL_, { method: "POST", headers: HEADERS, body: binaryMultipart() }),
    ],
  ] as const)("%s", async (_name, request) => {
    const fetchRec = recorder();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(fetchRec(request())).rejects.toThrow("in the request body");
    }
    expect(calls).toBe(0);
    expect(await written()).toHaveLength(0);
  });

  it("a hand-built multipart init string is refused the same way", async () => {
    await expect(
      recorder()(URL_, { method: "POST", headers: HEADERS, body: multipart([["api_key", FAKE_OPAQUE]]) }),
    ).rejects.toThrow("in the request body");
    expect(calls).toBe(0);
    expect(await written()).toHaveLength(0);
  });

  it("the committed-cassette scan refuses the wire form too", () => {
    const cassette: CassetteV1 = {
      schema_version: "1",
      request_hash: "0".repeat(32),
      request: {
        method: "POST",
        url: URL_,
        headers: HEADERS,
        body: multipart([["api_key", FAKE_OPAQUE]]),
        bodyEncoding: "raw",
      },
      response: { kind: "non_streaming", status: 200, headers: {}, body: "{}" },
      recorded_at: "2026-10-22T00:00:00Z",
    };
    expect(() => assertNoLeakedSecrets(cassette)).toThrow("in the request body");
  });
});

describe("controls", () => {
  it("a FormData Request with a named File was already refused (#231)", async () => {
    const request = new Request(URL_, {
      method: "POST",
      body: form(["api_key", FAKE_OPAQUE], ["file", new File(["x"], "a.txt")]),
    });
    await expect(recorder()(request)).rejects.toThrow("in the request body");
    expect(calls).toBe(0);
  });

  it.each([
    ["no credential field", multipart([["purpose", "batch"], ["file", "hello"]])],
    ["a key field with a short value", multipart([["key", "short"]])],
    ["a long value under a name that only ends in `key`", multipart([["monkey", FAKE_OPAQUE]])],
    ["an empty-filename FormData Request with no credential", null],
  ] as const)("%s still records", async (_name, body) => {
    const request =
      body === null
        ? new Request(URL_, { method: "POST", body: form(["purpose", "batch"], ["file", new File(["x"], "")]) })
        : new Request(URL_, { method: "POST", headers: HEADERS, body });
    await recorder()(request);
    expect(calls).toBe(1);
    expect(await written()).toHaveLength(1);
  });
});
