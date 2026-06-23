import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";

// Host matching must be case-insensitive: `URL.hostname` is always lower-cased
// and hostnames are case-insensitive (RFC 3986 §3.2.2), but a caller can pass a
// mixed-/upper-case host. Before the fix, that silently degraded the recorder to
// pass-through (no cassette written) — the worst shape for this toolkit.
describe("case-insensitive host matching", () => {
  let dir: string;
  let store: CassetteStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-host-"));
    store = new CassetteStore({ dir });
  });

  it("recorder intercepts a lower-case URL when the host entry is upper-case", async () => {
    let upstreamCalled = false;
    const upstream: typeof fetch = async () => {
      upstreamCalled = true;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const recorder = createRecorderFetch({
      upstream,
      store,
      hosts: new Set(["API.ANTHROPIC.COM"]),
    });
    const res = await recorder("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
    });

    expect(upstreamCalled).toBe(true); // recorder does hit upstream once...
    expect(res.status).toBe(200);
    // ...but the key assertion: the request was intercepted, so a cassette exists.
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
  });

  it("replayer matches a mixed-case host against a lower-case recorded URL", async () => {
    const upstream: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true, value: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    // Record with a lower-case host (the on-disk URL is lower-cased by URL()).
    const recorder = createRecorderFetch({ upstream, store, hosts: new Set(["api.anthropic.com"]) });
    await recorder("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
    });

    // Replay with a mixed-case host entry — must still intercept and serve it.
    const replayer = createReplayerFetch({ store, hosts: new Set(["Api.Anthropic.Com"]) });
    const replayed = await replayer("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.text()).toBe(JSON.stringify({ ok: true, value: 42 }));
  });
});
