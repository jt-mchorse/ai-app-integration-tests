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

  it("does not collide a raw body with a JSON body of the same shape (#57)", async () => {
    // A raw (non-JSON) body `foo` and a literal JSON body `{"__raw_body__":"foo"}`
    // used to canonicalize to the same `body` and hash equal — the second
    // recording silently overwrote the first, and replay served the wrong
    // response. They must now record as two distinct cassettes, each replaying
    // its own body.
    const rawUpstream: typeof fetch = async () =>
      new Response("raw-response", { status: 200, headers: { "content-type": "text/plain" } });
    const jsonUpstream: typeof fetch = async () =>
      new Response("json-response", { status: 200, headers: { "content-type": "text/plain" } });

    const rawRecorder = createRecorderFetch({ upstream: rawUpstream, store, hosts: HOSTS });
    await rawRecorder("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "foo", // not valid JSON -> raw
    });

    const jsonRecorder = createRecorderFetch({ upstream: jsonUpstream, store, hosts: HOSTS });
    await jsonRecorder("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ __raw_body__: "foo" }), // valid JSON of the old wrapper shape
    });

    // Two distinct recordings, not one overwritten file.
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(2);

    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    const rawReplay = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: "foo",
    });
    expect(await rawReplay.text()).toBe("raw-response");

    const jsonReplay = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: JSON.stringify({ __raw_body__: "foo" }),
    });
    expect(await jsonReplay.text()).toBe("json-response");
  });

  it("does not collide an explicit empty-string body with a no-body request (sibling of #57/#70)", async () => {
    // `fetch(url, { method: "POST", body: "" })` is a PRESENT body (Content-Length:
    // 0) — a different wire request than a no-body POST. The old `&& length > 0`
    // guard left the empty-string body untagged (`body:null`, no bodyEncoding),
    // byte-identical to a no-body request, so the two hash-collided: a never-
    // recorded no-body POST silently replayed the empty-body cassette. Each must
    // now record/replay as its own distinct cassette.
    const emptyUpstream: typeof fetch = async () =>
      new Response("empty-body-response", { status: 200, headers: { "content-type": "text/plain" } });
    const noBodyUpstream: typeof fetch = async () =>
      new Response("no-body-response", { status: 200, headers: { "content-type": "text/plain" } });

    const emptyRecorder = createRecorderFetch({ upstream: emptyUpstream, store, hosts: HOSTS });
    await emptyRecorder("https://api.anthropic.com/v1/messages", { method: "POST", body: "" });

    // Before recording the no-body request, replaying it must MISS (no collision).
    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    await expect(
      replayer("https://api.anthropic.com/v1/messages", { method: "POST" }),
    ).rejects.toBeInstanceOf(MissingCassetteError);

    const noBodyRecorder = createRecorderFetch({ upstream: noBodyUpstream, store, hosts: HOSTS });
    await noBodyRecorder("https://api.anthropic.com/v1/messages", { method: "POST" });

    // Two distinct recordings, not one overwritten file.
    const emptyFiles = await fs.readdir(dir);
    expect(emptyFiles).toHaveLength(2);

    // Each replays its own response.
    const emptyReplay = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: "",
    });
    expect(await emptyReplay.text()).toBe("empty-body-response");

    const noBodyReplay = await replayer("https://api.anthropic.com/v1/messages", { method: "POST" });
    expect(await noBodyReplay.text()).toBe("no-body-response");
  });

  it("does not collide two distinct URLSearchParams form bodies (sibling of #57/#84)", async () => {
    // A URLSearchParams body is a standard BodyInit that fetch serializes to
    // `application/x-www-form-urlencoded`. `readBodyAsText` used to drop it to
    // `null`, so every form POST looked like a no-body request: two DIFFERENT
    // form bodies hash-collided and one replayed the other's cassette (a false
    // test pass — the repo's core failure mode). Each distinct form body must
    // now record/replay as its own cassette.
    const upstreamA: typeof fetch = async () =>
      new Response("form-A", { status: 200, headers: { "content-type": "text/plain" } });
    const upstreamB: typeof fetch = async () =>
      new Response("form-B", { status: 200, headers: { "content-type": "text/plain" } });

    await createRecorderFetch({ upstream: upstreamA, store, hosts: HOSTS })(
      "https://api.anthropic.com/v1/messages",
      { method: "POST", body: new URLSearchParams({ foo: "1" }) },
    );
    await createRecorderFetch({ upstream: upstreamB, store, hosts: HOSTS })(
      "https://api.anthropic.com/v1/messages",
      { method: "POST", body: new URLSearchParams({ bar: "2" }) },
    );

    // Two distinct recordings, not one overwritten file.
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(2);

    // Each replays its own response — no cross-body collision.
    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    const replayA = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: new URLSearchParams({ foo: "1" }),
    });
    expect(await replayA.text()).toBe("form-A");

    const replayB = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: new URLSearchParams({ bar: "2" }),
    });
    expect(await replayB.text()).toBe("form-B");
  });

  it("does not collide non-Uint8Array typed-array / DataView bodies (sibling of #86/#84)", async () => {
    // Only Uint8Array + ArrayBuffer used to be decoded; every other ArrayBufferView
    // (Int16Array, DataView, …) dropped to `null` — byte-identical to a no-body
    // request. Two distinct Int16Array bodies hash-collided and one replayed the
    // other's cassette (the repo's core wrong-replay failure mode), and a view-body
    // POST collided with a no-body POST. Each distinct view body must now record/
    // replay as its own cassette, distinct from no-body.
    const upstreamA: typeof fetch = async () =>
      new Response("view-A", { status: 200, headers: { "content-type": "text/plain" } });
    const upstreamB: typeof fetch = async () =>
      new Response("view-B", { status: 200, headers: { "content-type": "text/plain" } });

    await createRecorderFetch({ upstream: upstreamA, store, hosts: HOSTS })(
      "https://api.anthropic.com/v1/messages",
      { method: "POST", body: new Int16Array([1, 2, 3]) },
    );
    // A no-body POST must MISS, not collide with the typed-array recording.
    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    await expect(
      replayer("https://api.anthropic.com/v1/messages", { method: "POST" }),
    ).rejects.toBeInstanceOf(MissingCassetteError);

    // A DataView carrying different bytes is its own distinct request.
    await createRecorderFetch({ upstream: upstreamB, store, hosts: HOSTS })(
      "https://api.anthropic.com/v1/messages",
      { method: "POST", body: new DataView(new Uint8Array([9, 9, 9]).buffer) },
    );

    const files = await fs.readdir(dir);
    expect(files).toHaveLength(2);

    const replayA = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: new Int16Array([1, 2, 3]),
    });
    expect(await replayA.text()).toBe("view-A");

    const replayB = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: new DataView(new Uint8Array([9, 9, 9]).buffer),
    });
    expect(await replayB.text()).toBe("view-B");
  });

  it("does not collide two distinct Blob bodies (sibling of #86/#88)", async () => {
    // A Blob body has fixed, deterministic bytes (no random multipart boundary —
    // that's a FormData concept) that fetch serializes exactly; it used to drop to
    // `null`, byte-identical to a no-body request. Two distinct Blob bodies
    // hash-collided and one replayed the other's cassette, and a Blob-body POST
    // collided with a no-body POST. Each distinct Blob body must now record/replay
    // as its own cassette, distinct from no-body. `File extends Blob`, so a File
    // body rides the same branch.
    const upstreamA: typeof fetch = async () =>
      new Response("blob-A", { status: 200, headers: { "content-type": "text/plain" } });
    const upstreamB: typeof fetch = async () =>
      new Response("blob-B", { status: 200, headers: { "content-type": "text/plain" } });

    await createRecorderFetch({ upstream: upstreamA, store, hosts: HOSTS })(
      "https://api.anthropic.com/v1/messages",
      { method: "POST", body: new Blob(["ALPHA-payload"]) },
    );
    // A no-body POST must MISS, not collide with the Blob recording.
    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    await expect(
      replayer("https://api.anthropic.com/v1/messages", { method: "POST" }),
    ).rejects.toBeInstanceOf(MissingCassetteError);

    // A Blob carrying different bytes is its own distinct request.
    await createRecorderFetch({ upstream: upstreamB, store, hosts: HOSTS })(
      "https://api.anthropic.com/v1/messages",
      { method: "POST", body: new Blob(["BETA-payload"]) },
    );

    const files = await fs.readdir(dir);
    expect(files).toHaveLength(2);

    const replayA = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: new Blob(["ALPHA-payload"]),
    });
    expect(await replayA.text()).toBe("blob-A");

    const replayB = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: new Blob(["BETA-payload"]),
    });
    expect(await replayB.text()).toBe("blob-B");
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

describe("null-body statuses (204/205/304) round-trip without crashing (#68)", () => {
  // Per the Fetch spec these statuses forbid ANY response body — `new Response`
  // throws a TypeError even for an empty-string body, only `null` is allowed.
  // Pre-fix both the record path (new Response(text, ...)) and the replay path
  // (rebuildResponse) passed `""` and crashed on a perfectly valid 204 (e.g. a
  // DELETE). Every other test uses status 200, so the class was never exercised.
  let dir: string;
  let store: CassetteStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-nullbody-"));
    store = new CassetteStore({ dir });
  });

  for (const status of [204, 205, 304]) {
    it(`records a ${status} upstream and replays it without throwing`, async () => {
      const upstream: typeof fetch = async () =>
        new Response(null, { status, headers: { "x-server": "fake" } });

      const recorder = createRecorderFetch({ upstream, store, hosts: HOSTS });
      const recorded = await recorder("https://api.anthropic.com/v1/messages/abc", {
        method: "DELETE",
        headers: { "x-api-key": "sk-ant-must-not-leak-1234567890abcdefghij" },
      });
      expect(recorded.status).toBe(status);
      expect(await recorded.text()).toBe("");

      const replayer = createReplayerFetch({ store, hosts: HOSTS });
      const replayed = await replayer("https://api.anthropic.com/v1/messages/abc", {
        method: "DELETE",
        headers: { "x-api-key": "different-but-hash-stable" },
      });
      expect(replayed.status).toBe(status);
      expect(await replayed.text()).toBe("");
    });
  }
});

describe("JSON-null body does not collide with a no-body request (#70)", () => {
  let dir: string;
  let store: CassetteStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-"));
    store = new CassetteStore({ dir });
  });

  it("records both distinctly and replays each its own response", async () => {
    // A POST with the JSON literal `null` body and a POST with no body both
    // canonicalize to `body:null`; before #70 they hashed identically, so the
    // second recording overwrote the first cassette and replay served the wrong
    // response. They must now write two distinct cassettes and replay correctly.
    const upstreamNull: typeof fetch = async () => new Response("RESP-FOR-NULL-BODY", { status: 200 });
    const upstreamNo: typeof fetch = async () => new Response("RESP-FOR-NO-BODY", { status: 200 });

    await createRecorderFetch({ upstream: upstreamNull, store, hosts: HOSTS })(
      "https://api.anthropic.com/v1/messages",
      { method: "POST", body: "null" },
    );
    await createRecorderFetch({ upstream: upstreamNo, store, hosts: HOSTS })(
      "https://api.anthropic.com/v1/messages",
      { method: "POST" },
    );

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(2);

    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    const nullResp = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: "null",
    });
    const noResp = await replayer("https://api.anthropic.com/v1/messages", { method: "POST" });
    expect(await nullResp.text()).toBe("RESP-FOR-NULL-BODY");
    expect(await noResp.text()).toBe("RESP-FOR-NO-BODY");
  });
});

describe("FormData body enters the request hash (#92)", () => {
  let dir: string;
  let store: CassetteStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-fd-"));
    store = new CassetteStore({ dir });
  });

  const upstream = (text: string): typeof fetch =>
    (async () =>
      new Response(text, {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;

  const post = (body?: BodyInit): RequestInit =>
    body === undefined ? { method: "POST" } : { method: "POST", body };

  const URL_ = "https://api.anthropic.com/v1/messages";

  function form(...pairs: Array<[string, string | Blob]>): FormData {
    const fd = new FormData();
    for (const [name, value] of pairs) fd.append(name, value);
    return fd;
  }

  it("does not collide two distinct FormData bodies (sibling of #86/#88/#90)", async () => {
    // A FormData body used to drop to `null`, byte-identical to a no-body
    // request: recording `field=ALPHA` and then replaying `field=BETA` served
    // the ALPHA cassette, silently. The boundary that made this look
    // un-canonicalizable belongs to the serialized bytes; the hash uses the
    // logical entries, which are deterministic.
    await createRecorderFetch({ upstream: upstream("form-A"), store, hosts: HOSTS })(
      URL_,
      post(form(["field", "ALPHA"])),
    );

    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    await expect(replayer(URL_, post(form(["field", "BETA"])))).rejects.toBeInstanceOf(
      MissingCassetteError,
    );

    await createRecorderFetch({ upstream: upstream("form-B"), store, hosts: HOSTS })(
      URL_,
      post(form(["field", "BETA"])),
    );
    expect(await (await replayer(URL_, post(form(["field", "ALPHA"])))).text()).toBe("form-A");
    expect(await (await replayer(URL_, post(form(["field", "BETA"])))).text()).toBe("form-B");
  });

  it("does not collide a FormData POST with a no-body POST", async () => {
    await createRecorderFetch({ upstream: upstream("form-body"), store, hosts: HOSTS })(
      URL_,
      post(form(["field", "ALPHA"])),
    );
    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    await expect(replayer(URL_, post())).rejects.toBeInstanceOf(MissingCassetteError);

    await createRecorderFetch({ upstream: upstream("no-body"), store, hosts: HOSTS })(URL_, post());
    expect(await (await replayer(URL_, post())).text()).toBe("no-body");
    expect(await (await replayer(URL_, post(form(["field", "ALPHA"])))).text()).toBe("form-body");
  });

  it("distinguishes a repeated field name from a single one", async () => {
    // `append` twice is legal and is a different wire request. A dict-shaped
    // canonical form would lose one of them; the entry list keeps both.
    await createRecorderFetch({ upstream: upstream("twice"), store, hosts: HOSTS })(
      URL_,
      post(form(["f", "x"], ["f", "x"])),
    );
    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    await expect(replayer(URL_, post(form(["f", "x"])))).rejects.toBeInstanceOf(
      MissingCassetteError,
    );
  });

  it("distinguishes a string value from a File with the same name and content", async () => {
    // Without the "s"/"f" tag these would serialize alike. A File also carries a
    // filename and type that belong in the hash.
    await createRecorderFetch({ upstream: upstream("string-value"), store, hosts: HOSTS })(
      URL_,
      post(form(["f", "payload"])),
    );
    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    await expect(
      replayer(URL_, post(form(["f", new File(["payload"], "f", { type: "text/plain" })]))),
    ).rejects.toBeInstanceOf(MissingCassetteError);
  });

  it("distinguishes two Files that differ only by filename", async () => {
    await createRecorderFetch({ upstream: upstream("a-txt"), store, hosts: HOSTS })(
      URL_,
      post(form(["f", new File(["same"], "a.txt", { type: "text/plain" })])),
    );
    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    await expect(
      replayer(URL_, post(form(["f", new File(["same"], "b.txt", { type: "text/plain" })]))),
    ).rejects.toBeInstanceOf(MissingCassetteError);
  });

  it("does not consume the body — the same FormData still reaches upstream", async () => {
    // The property that separates FormData from ReadableStream, and the one that
    // would make this fix unsafe if it were wrong. Assert it directly rather
    // than trusting the spec.
    let seen: FormData | null = null;
    const capturing: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = (init?.body as FormData) ?? null;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const fd = form(["field", "ALPHA"], ["field", "BETA"]);
    await createRecorderFetch({ upstream: capturing, store, hosts: HOSTS })(URL_, post(fd));

    expect(seen).toBeInstanceOf(FormData);
    expect([...(seen as unknown as FormData).entries()]).toEqual([
      ["field", "ALPHA"],
      ["field", "BETA"],
    ]);
    // And the original is still readable too.
    expect(fd.getAll("field")).toEqual(["ALPHA", "BETA"]);
  });

  it("still drops a ReadableStream body to null", async () => {
    // Narrowing the skip comment to ReadableStream must not have widened the
    // branch: a stream is single-read, so hashing it would take the body away
    // from the upstream request. Two distinct stream bodies still collide, and
    // that stays a documented limitation.
    const stream = (text: string): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });

    await createRecorderFetch({ upstream: upstream("stream-A"), store, hosts: HOSTS })(URL_, {
      method: "POST",
      body: stream("ALPHA"),
      // @ts-expect-error - duplex is required for a stream body and not in the DOM lib types here
      duplex: "half",
    });
    const replayer = createReplayerFetch({ store, hosts: HOSTS });
    expect(await (await replayer(URL_, post())).text()).toBe("stream-A");
  });
});

describe("the recorder forwards the caller's own body upstream (#93)", () => {
  let dir: string;
  let store: CassetteStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-up-"));
    store = new CassetteStore({ dir });
  });

  const URL_ = "https://api.anthropic.com/v1/messages";

  /** Records one request and returns whatever the upstream fetch received as its body. */
  async function bodySeenUpstream(body: BodyInit): Promise<unknown> {
    let seen: unknown;
    const capturing: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.body;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    await createRecorderFetch({ upstream: capturing, store, hosts: HOSTS })(URL_, {
      method: "POST",
      body,
    });
    return seen;
  }

  it("forwards binary bytes intact, not TextDecoder mojibake", async () => {
    // The sharp one. `bodyText` used to win, so a PNG header went upstream as
    // "�PNG��" — the live API received corrupted bytes and the
    // cassette recorded the response to a request the caller never made.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
    const seen = await bodySeenUpstream(bytes);
    expect(seen).toBeInstanceOf(Uint8Array);
    expect([...(seen as Uint8Array)]).toEqual([...bytes]);
    // And specifically not the lossy decode that used to be sent.
    expect(new TextDecoder().decode(bytes)).toContain("�");
    expect(typeof seen).not.toBe("string");
  });

  it("forwards a Blob as a Blob, preserving its type", async () => {
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    const seen = await bodySeenUpstream(blob);
    expect(seen).toBeInstanceOf(Blob);
    expect((seen as Blob).type).toBe("image/png");
  });

  it("forwards URLSearchParams as URLSearchParams", async () => {
    // Byte-equivalent as a string, but `fetch` only sets
    // `Content-Type: application/x-www-form-urlencoded` for the real thing.
    const seen = await bodySeenUpstream(new URLSearchParams({ foo: "1" }));
    expect(seen).toBeInstanceOf(URLSearchParams);
  });

  it("forwards FormData as FormData with its entries intact", async () => {
    // Reading the entries for hashing must not consume or replace them — the
    // property that separates FormData from ReadableStream, and the one that
    // would make #92's decode unsafe if it were wrong.
    const fd = new FormData();
    fd.append("field", "ALPHA");
    fd.append("field", "BETA");
    const seen = await bodySeenUpstream(fd);
    expect(seen).toBeInstanceOf(FormData);
    expect([...(seen as FormData).entries()]).toEqual([
      ["field", "ALPHA"],
      ["field", "BETA"],
    ]);
    expect(fd.getAll("field")).toEqual(["ALPHA", "BETA"]);
  });

  it("leaves a string body exactly as it was", async () => {
    // Where `bodyText === init.body`, which is why this went unnoticed for as
    // long as string bodies were the only decoded kind.
    expect(await bodySeenUpstream("hello")).toBe("hello");
  });

  it("still forwards a body that came from a Request input", async () => {
    // The clone path is the one case `bodyText` was written for: `init` has no
    // body, so the fallback has to fire or the upstream request loses it.
    let seen: unknown;
    const capturing: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.body;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const request = new Request(URL_, { method: "POST", body: "from-request-input" });
    await createRecorderFetch({ upstream: capturing, store, hosts: HOSTS })(request);
    expect(seen).toBe("from-request-input");
  });

  it("does not change which cassette any body type hashes to", async () => {
    // Fidelity upstream must not disturb the hash — every body-collision fix
    // from #57 through #92 depends on it. Record each type twice and assert one
    // cassette per type, not one per attempt.
    const bodies: BodyInit[] = [
      "hello",
      new URLSearchParams({ foo: "1" }),
      new Uint8Array([1, 2, 3]),
      new Blob(["blob-payload"]),
    ];
    for (const body of bodies) {
      for (let i = 0; i < 2; i++) {
        await createRecorderFetch({
          upstream: (async () => new Response("ok", { status: 200 })) as typeof fetch,
          store,
          hosts: HOSTS,
        })(URL_, { method: "POST", body });
      }
    }
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(bodies.length);
  });
});
