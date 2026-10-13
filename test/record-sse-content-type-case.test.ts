/**
 * The SSE branch is chosen by media type, in any case (#196).
 *
 * The recorder tested `contentType.includes("text/event-stream")` on the value
 * as sent. Media type names are case-insensitive (RFC 9110 §8.3.1) and
 * `Headers` does not normalise values, so an upstream or proxy sending
 * `Text/Event-Stream` was recorded as one `non_streaming` body. Measured on
 * main (6f3db44): a three-event stream replayed as 3 chunks under
 * `text/event-stream` and as 1 chunk under `Text/Event-Stream` and
 * `TEXT/EVENT-STREAM; charset=utf-8` -- the lost chunk boundaries #104 fixed
 * for CR/CRLF framing, one header over.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";

const HOSTS = new Set(["api.example.com"]);
const URL_ = "https://api.example.com/v1/messages";
const EVENTS = ["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"];

let dir: string;
let store: CassetteStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-sse-ct-"));
  store = new CassetteStore({ dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Serve the three events, one read each, under `contentType`. */
function upstream(contentType: string): typeof fetch {
  return (async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of EVENTS) controller.enqueue(enc.encode(e));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": contentType } });
  }) as typeof fetch;
}

async function chunksOf(res: Response): Promise<string[]> {
  const out: string[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out.push(dec.decode(value));
  }
}

async function recordedKind(): Promise<string> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(await fs.readFile(path.join(dir, files[0] as string), "utf8")).response.kind;
}

describe("an SSE content type in any case records as a stream (#196)", () => {
  it.each([
    "text/event-stream",
    "Text/Event-Stream",
    "TEXT/EVENT-STREAM",
    "TEXT/EVENT-STREAM; charset=utf-8",
    "text/Event-Stream;charset=UTF-8",
  ])("%s: one frame per event, replayed as one chunk per frame", async (ct) => {
    const rec = createRecorderFetch({ upstream: upstream(ct), store, hosts: HOSTS });
    await (await rec(URL_)).text();
    expect(await recordedKind()).toBe("sse");

    const replay = createReplayerFetch({ store, hosts: HOSTS });
    expect(await chunksOf(await replay(URL_))).toEqual(EVENTS);
  });

  it("a non-SSE content type is still recorded as non_streaming", async () => {
    const rec = createRecorderFetch({ upstream: upstream("Application/JSON"), store, hosts: HOSTS });
    await (await rec(URL_)).text();
    expect(await recordedKind()).toBe("non_streaming");
  });
});
