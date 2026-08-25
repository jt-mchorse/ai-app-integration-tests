/**
 * The recorder must find an SSE separator in all three of its forms (#104, D-012).
 *
 * `captureSse` scanned for `"\n\n"` only. The WHATWG SSE spec ends a line with
 * ANY of `\r\n`, `\n`, or `\r`, so a CRLF- or CR-framed upstream never matched,
 * the whole stream accumulated in the buffer, and the trailing
 * `if (buf.length > 0) frames.push(buf)` swept it into ONE element. Measured on
 * the same three-event stream:
 *
 *     upstream   frames  replayBody preserved?  chunks the app sees on replay
 *     LF              3  yes                    3
 *     CRLF            1  yes                    1
 *     CR              1  yes                    1
 *
 * No bytes were lost — `frames.join("")` still reassembled the body exactly.
 * What was lost is the **chunk boundaries**, which is the one property a
 * streaming-integration-test harness exists to preserve: the replayer enqueues
 * one chunk per frame with no synthetic delay, so a three-event stream replayed
 * as a single chunk and a test asserting progressive rendering behaved
 * differently against the cassette than against the live API. Silently, with a
 * green cassette.
 *
 * Same class as `nextjs-streaming-ai-patterns#95` / `#106`. The outcome differs
 * — that repo *dropped* the stream, this one *merged* it — only because of the
 * trailing tail push.
 *
 * Frames are stored **verbatim**, original line endings and all (D-012). That
 * is why every case below asserts `frames.join("") === wire` as well as the
 * count: normalizing the stored text would fix the count by breaking the one
 * property that survived the old scan.
 */
import { describe, expect, it } from "vitest";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRecorderFetch } from "../src/fetch-recorder.js";
import { CassetteStore } from "../src/io.js";
import type { CassetteV1 } from "../src/cassette.js";

const HOST = "sse.example.com";

/** A body whose frames are separated by `sep`-flavoured blank lines. */
function eventStream(sep: string): string {
  return [
    "event: a",
    'data: {"i":1}',
    "",
    "event: b",
    'data: {"i":2}',
    "",
    "event: c",
    'data: {"i":3}',
    "",
    "",
  ].join(sep);
}

const LF = "\n";
const CRLF = "\r\n";
const CR = "\r";

/** Serve `text` as `text/event-stream`, `chunkSize` bytes per read. */
function sseUpstream(text: string, chunkSize: number) {
  return async (): Promise<Response> => {
    const bytes = new TextEncoder().encode(text);
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(i, i + chunkSize));
        i += chunkSize;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

async function record(
  text: string,
  chunkSize: number,
): Promise<{ frames: string[]; joined: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-sse-"));
  const store = new CassetteStore({ dir });
  const recorder = createRecorderFetch({
    upstream: sseUpstream(text, chunkSize) as unknown as typeof fetch,
    store,
    hosts: new Set([HOST]),
  });
  const res = await recorder(`https://${HOST}/v1/messages`, { method: "POST", body: "{}" });
  await res.text();

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  expect(files.length, "expected exactly one cassette").toBe(1);
  const cassette = JSON.parse(
    await fs.readFile(path.join(dir, files[0] as string), "utf8"),
  ) as CassetteV1;
  expect(cassette.response.kind).toBe("sse");
  const frames = (cassette.response as { kind: "sse"; frames: string[] }).frames;
  return { frames, joined: frames.join("") };
}

// (label, wire body, expected frame count). Counts are the post-fix truth; the
// docstring records what CRLF and CR produced before it.
const CASES: ReadonlyArray<readonly [string, string, number]> = [
  ["LF framing (control)", eventStream(LF), 3],
  ["CRLF framing", eventStream(CRLF), 3],
  ["CR framing", eventStream(CR), 3],
  ["mixed LF and CRLF", `event: a\ndata: 1\n\nevent: b\r\ndata: 2\r\n\r\n`, 2],
  ["LF, unterminated tail", 'event: a\ndata: {"i":1}\n\nevent: b\ndata: {"i":2}', 2],
];

// 1 puts every separator byte in its own read, which is the only way to
// exercise the held-back `\r`; 3 lands mid-token; 4096 is one read.
const CHUNK_SIZES = [1, 3, 7, 4096];

describe("SSE capture across line-ending conventions", () => {
  it("the table covers more than the LF happy path", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(4);
    expect(CASES.filter(([, body]) => body.includes(CR)).length).toBeGreaterThanOrEqual(2);
  });

  for (const chunkSize of CHUNK_SIZES) {
    describe(`read chunk size ${chunkSize}`, () => {
      for (const [label, wire, expected] of CASES) {
        it(`${label} records ${expected} frame(s)`, async () => {
          const { frames } = await record(wire, chunkSize);
          expect(frames.length).toBe(expected);
        });

        it(`${label} preserves the wire bytes exactly`, async () => {
          // D-012: frames are stored verbatim. This is the property that
          // survived the old scan, and the fix must not trade it for the count.
          const { joined } = await record(wire, chunkSize);
          expect(joined).toBe(wire);
        });
      }
    });
  }

  it("a CR split across two reads is not turned into a frame boundary", async () => {
    // `...\r` + `\n...` is ONE terminator. Deciding the `\r` eagerly at the end
    // of a read would manufacture a boundary that is not in the stream — which
    // a chunk size of 1 exercises on every CRLF byte pair.
    const wire = eventStream(CRLF);
    const byOne = await record(wire, 1);
    const whole = await record(wire, 4096);
    expect(byOne.frames).toEqual(whole.frames);
  });

  it("every frame ends at a separator, and only the tail may not", async () => {
    // The schema's own claim about `frames`: "Each element is the text of one
    // SSE frame including its terminating blank line." Asserted rather than
    // restated — under CRLF the single merged element satisfied neither half.
    const { frames } = await record(eventStream(CRLF), 4096);
    for (const frame of frames) {
      expect(/(\r\n|\n|\r){2}$/.test(frame), JSON.stringify(frame)).toBe(true);
    }
  });

  it("the LF path is byte-identical to what it recorded before", async () => {
    // The control that matters most: no existing cassette may change, or every
    // committed recording would need re-capturing.
    const { frames } = await record(eventStream(LF), 4096);
    expect(frames).toEqual([
      'event: a\ndata: {"i":1}\n\n',
      'event: b\ndata: {"i":2}\n\n',
      'event: c\ndata: {"i":3}\n\n',
    ]);
  });
});
