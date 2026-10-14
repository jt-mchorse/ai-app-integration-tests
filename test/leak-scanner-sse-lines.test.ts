/**
 * The leak scanner reads an SSE frame's data the way an SSE consumer does (#191).
 *
 * #183 parses each `data:` payload so a key inside its JSON is seen unescaped,
 * but it found the payloads with `split(/\r?\n/)` and parsed each line alone.
 * The recorder splits frames on all three SSE line endings (D-012), so:
 *
 * - a CR-framed event with an `event:` line was ONE line starting `event:`, its
 *   payload was never parsed, and the escaped `\nsk-ant-...` slipped the `\b`;
 * - a JSON payload spread over two `data:` lines (the spec joins them with
 *   `\n`) failed to parse line by line.
 *
 * Both were recorded and passed the committed-cassette rescan.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";
import { createRecorderFetch } from "../src/fetch-recorder.js";
import { CassetteStore } from "../src/io.js";

const SKANT = "sk-ant-api03-" + "Ab3dEfGh1jKlMn0pQrStUvWxYz012345678";
// Built from code points so no escape in this file is doing the work.
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const CRLF = CR + LF;
const BACKSLASH = String.fromCharCode(92);

/** A text delta whose JSON string holds an escaped newline before the key. */
const LEAKY_HEAD = '{"type":"content_block_delta",';
const LEAKY_TAIL = `"delta":{"text":"line1${BACKSLASH}n${SKANT}"}}`;
const LEAKY = LEAKY_HEAD + LEAKY_TAIL;
const BENIGN_HEAD = '{"type":"content_block_delta",';
const BENIGN_TAIL = '"delta":{"text":"the key: value"}}';

function sse(...frames: string[]): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "abc",
    request: { method: "POST", url: "https://x/y", headers: {}, body: null },
    response: { kind: "sse", status: 200, headers: {}, frames },
    recorded_at: "2026-10-13T00:00:00Z",
  };
}

const ev = (eol: string, ...data: string[]): string =>
  `event: content_block_delta${eol}` + data.map((d) => `data: ${d}${eol}`).join("") + eol;

const REFUSE: Array<[string, CassetteV1]> = [
  ["CR-framed event with an event: line", sse(ev(CR, LEAKY))],
  ["multi-line data: field, LF", sse(ev(LF, LEAKY_HEAD, LEAKY_TAIL))],
  ["multi-line data: field, CR", sse(ev(CR, LEAKY_HEAD, LEAKY_TAIL))],
  ["multi-line data: field, CRLF", sse(ev(CRLF, LEAKY_HEAD, LEAKY_TAIL))],
  ["multi-line data: field with no space after the colon", sse(`data:${LEAKY_HEAD}${LF}data:${LEAKY_TAIL}${LF}${LF}`)],
];

// The controls: what #183 already refused, and must keep refusing.
const CONTROLS: Array<[string, CassetteV1]> = [
  ["LF-framed event with an event: line", sse(ev(LF, LEAKY))],
  ["CRLF-framed event with an event: line", sse(ev(CRLF, LEAKY))],
];

const ALLOW: Array<[string, CassetteV1]> = [
  ["a CR-framed stream of text deltas", sse(ev(CR, BENIGN_HEAD + BENIGN_TAIL), ev(CR, '{"type":"message_stop"}'))],
  ["a multi-line data: field of ordinary JSON", sse(ev(LF, BENIGN_HEAD, BENIGN_TAIL))],
];

describe("the leak scanner reads SSE lines and data fields as the spec does (#191)", () => {
  it.each(REFUSE)("refuses: %s", (_name, cassette) => {
    expect(() => assertNoLeakedSecrets(cassette)).toThrow(/in the response/);
  });

  it.each(CONTROLS)("still refuses: %s", (_name, cassette) => {
    expect(() => assertNoLeakedSecrets(cassette)).toThrow(/in the response/);
  });

  it.each(ALLOW)("allows: %s", (_name, cassette) => {
    expect(() => assertNoLeakedSecrets(cassette)).not.toThrow();
  });

  it("the recorder refuses to write a CR-framed upstream that echoes a key", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-191-"));
    try {
      const upstream = async (): Promise<Response> =>
        new Response(ev(CR, LEAKY), { status: 200, headers: { "content-type": "text/event-stream" } });
      const recorder = createRecorderFetch({
        upstream: upstream as unknown as typeof fetch,
        store: new CassetteStore({ dir }),
        hosts: new Set(["sse.example.com"]),
      });
      await expect(
        (async () => {
          const res = await recorder("https://sse.example.com/v1/messages", { method: "POST", body: "{}" });
          await res.text();
        })(),
      ).rejects.toThrow(/unredacted secret/);
      expect((await fs.readdir(dir)).filter((f) => f.endsWith(".json"))).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
