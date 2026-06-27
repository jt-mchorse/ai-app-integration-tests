import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CassetteStore,
  MissingCassetteError,
  createRecorderFetch,
  createReplayerFetch,
} from "../src/index.js";

const HOSTS = new Set(["api.anthropic.com"]);

describe("record then replay (non-streaming)", () => {
  let dir: string;
  let store: CassetteStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-"));
    store = new CassetteStore({ dir });
  });

  it("records a JSON response and replays it byte-for-byte", async () => {
    const upstream: typeof fetch = async () => {
      return new Response(JSON.stringify({ ok: true, value: 7 }), {
        status: 200,
        headers: { "content-type": "application/json", "x-server": "fake" },
      });
    };

    const recorder = createRecorderFetch({ upstream, store, hosts: HOSTS });
    const recorded = await recorder("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-ant-must-not-leak-1234567890abcdefghij" },
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(recorded.status).toBe(200);
    expect(await recorded.text()).toBe(JSON.stringify({ ok: true, value: 7 }));

    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    const replayed = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "this-key-is-different-but-hash-stable" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: "claude-haiku-4-5" }),
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.text()).toBe(JSON.stringify({ ok: true, value: 7 }));
  });

  it("replays a request recorded with a URL fragment when replayed without one (#56)", async () => {
    // The fragment never reaches the server, so a request recorded with `#...`
    // and replayed without it is wire-identical and must hit the cassette.
    const upstream: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const recorder = createRecorderFetch({ upstream, store, hosts: HOSTS });
    await recorder("https://api.anthropic.com/v1/messages?model=x#section-2", {
      method: "POST",
      headers: { "x-api-key": "sk-ant-must-not-leak-1234567890abcdefghij" },
      body: JSON.stringify({ model: "x", messages: [] }),
    });

    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    const replayed = await replayer("https://api.anthropic.com/v1/messages?model=x", {
      method: "POST",
      headers: { "x-api-key": "different-but-hash-stable" },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.text()).toBe(JSON.stringify({ ok: true }));
  });

  it("redacts api keys before writing the cassette to disk", async () => {
    const upstream: typeof fetch = async () =>
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });

    const recorder = createRecorderFetch({ upstream, store, hosts: HOSTS });
    await recorder("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-ant-do-not-leak-1234567890abcdefghij" },
      body: JSON.stringify({ model: "x", messages: [] }),
    });

    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    const onDisk = await fs.readFile(path.join(dir, files[0]), "utf8");
    expect(onDisk).not.toContain("sk-ant-do-not-leak");
    expect(onDisk).toContain("[REDACTED]");
  });

  it("coerces a non-string array-of-tuples header value to a string in the cassette (#52)", async () => {
    const upstream: typeof fetch = async () =>
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });

    const recorder = createRecorderFetch({ upstream, store, hosts: HOSTS });
    await recorder("https://api.anthropic.com/v1/messages", {
      method: "POST",
      // Array-of-tuples HeadersInit with a non-string value (untyped JS caller).
      // The object path already String()-coerces; the array path must too, or
      // the cassette stores a raw number — contract violation + spurious miss.
      headers: [["x-count", 5 as unknown as string]],
      body: JSON.stringify({ model: "x", messages: [] }),
    });

    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    const cassette = JSON.parse(await fs.readFile(path.join(dir, files[0]), "utf8"));
    expect(cassette.request.headers["x-count"]).toBe("5");
    expect(typeof cassette.request.headers["x-count"]).toBe("string");
  });

  it("leaves a string array-of-tuples header value unchanged", async () => {
    const upstream: typeof fetch = async () =>
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });

    const recorder = createRecorderFetch({ upstream, store, hosts: HOSTS });
    await recorder("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: [["x-trace", "abc"]],
      body: JSON.stringify({ model: "x", messages: [] }),
    });

    const files = await fs.readdir(dir);
    const cassette = JSON.parse(await fs.readFile(path.join(dir, files[0]), "utf8"));
    expect(cassette.request.headers["x-trace"]).toBe("abc");
  });
});

describe("record then replay (SSE streaming)", () => {
  let dir: string;
  let store: CassetteStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-"));
    store = new CassetteStore({ dir });
  });

  it("captures and replays SSE frames in order", async () => {
    const frames = [
      'data: {"text":"Hello"}\n\n',
      'data: {"text":" world"}\n\n',
      "event: done\ndata: {}\n\n",
    ];
    const upstream: typeof fetch = async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const f of frames) controller.enqueue(encoder.encode(f));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const recorder = createRecorderFetch({ upstream, store, hosts: HOSTS });
    const recorded = await recorder("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-ant-stream-secret-1234567890abcdefghij" },
      body: JSON.stringify({ model: "x", stream: true }),
    });
    expect(await recorded.text()).toBe(frames.join(""));

    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    const replayed = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: JSON.stringify({ stream: true, model: "x" }),
    });
    const out = await replayed.text();
    expect(out).toBe(frames.join(""));
  });

  it("preserves a truncated trailing UTF-8 sequence instead of silently dropping it", async () => {
    // A stream that ends mid-multibyte-character (a truncated/aborted recording)
    // leaves an incomplete sequence buffered in the streaming TextDecoder. Without
    // the final flush those bytes vanish from the recorded body; the flush emits
    // the standard U+FFFD replacement char so nothing is silently lost.
    const completeFrame = 'data: {"text":"hi"}\n\n';
    const upstream: typeof fetch = async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(completeFrame));
          // First two bytes of "✓" (E2 9C 93) — the third byte never arrives.
          controller.enqueue(new Uint8Array([0xe2, 0x9c]));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const recorder = createRecorderFetch({ upstream, store, hosts: HOSTS });
    const recorded = await recorder("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-ant-stream-secret-1234567890abcdefghij" },
      body: JSON.stringify({ model: "x", stream: true }),
    });
    // The replacement char must be present — pre-fix the bytes were dropped and
    // the body equaled `completeFrame` exactly.
    expect(await recorded.text()).toBe(`${completeFrame}�`);

    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    const replayed = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: JSON.stringify({ stream: true, model: "x" }),
    });
    expect(await replayed.text()).toBe(`${completeFrame}�`);
  });
});

describe("missing cassette in replay mode", () => {
  it("throws MissingCassetteError with the request hash", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-"));
    const store = new CassetteStore({ dir });
    const replayer = createReplayerFetch({ store, hosts: HOSTS });

    await expect(
      replayer("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "x" }),
      }),
    ).rejects.toBeInstanceOf(MissingCassetteError);
  });
});

describe("non-intercepted hosts", () => {
  it("recorder passes them straight through", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-"));
    const store = new CassetteStore({ dir });
    let upstreamCalled = false;
    const upstream: typeof fetch = async () => {
      upstreamCalled = true;
      return new Response("noop");
    };
    const recorder = createRecorderFetch({ upstream, store, hosts: HOSTS });
    await recorder("https://example.com/foo", { method: "GET" });
    expect(upstreamCalled).toBe(true);
    const files = await fs.readdir(dir).catch(() => []);
    expect(files).toHaveLength(0);
  });

  it("replayer throws so tests fail loudly on a forgotten host", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-"));
    const store = new CassetteStore({ dir });
    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    await expect(replayer("https://example.com/foo", { method: "GET" })).rejects.toThrow(
      /non-intercepted host/,
    );
  });
});
