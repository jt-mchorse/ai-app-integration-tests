import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";

// Whitespace axis of `normalizeHosts` (#95), sibling to the case axis in
// host-matching.test.ts.
//
// `normalizeHosts` lower-cased but did not trim, so `" api.anthropic.com "`
// never matched the padded-free `URL.hostname`: the recorder passed the call
// through to the real upstream and wrote NO cassette, with no error. That is
// the harm both `validateHosts` gates (#26 installer, #34 factory) exist to
// prevent — "tests pass green but were actually hitting live APIs".
//
// Padding is not contrived. The obvious way to make the list configurable is
// `process.env.RECORD_HOSTS?.split(",")`, and `"a.com, b.com".split(",")`
// yields `" b.com"`. Cross-repo sibling of mcp-server-cookbook#52.
//
// Every assertion here is on **a cassette being written**, not on a boolean.
// The defect was that the recorder *looked* like it worked — it returned a
// normal 200 — so anything weaker than checking the artifact would have passed
// on the broken tree.

const PADDED_HOSTS: ReadonlyArray<{ host: string; label: string }> = [
  { host: " api.anthropic.com", label: "leading space" },
  { host: "api.anthropic.com ", label: "trailing space" },
  { host: "  api.anthropic.com  ", label: "both sides" },
  { host: "\tapi.anthropic.com", label: "leading tab" },
  { host: "api.anthropic.com\n", label: "trailing newline" },
  { host: "  API.Anthropic.COM \n", label: "padding combined with mixed case" },
];

function stubUpstream(): { upstream: typeof fetch; calls: () => number } {
  let n = 0;
  const upstream: typeof fetch = async () => {
    n += 1;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { upstream, calls: () => n };
}

describe("whitespace-insensitive host matching (#95)", () => {
  let dir: string;
  let store: CassetteStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-host-ws-"));
    store = new CassetteStore({ dir });
  });

  it.each(PADDED_HOSTS)(
    "recorder writes a cassette when the host entry has $label",
    async ({ host }) => {
      const { upstream, calls } = stubUpstream();
      const recorder = createRecorderFetch({ upstream, store, hosts: new Set([host]) });

      const res = await recorder("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
      });

      expect(res.status).toBe(200);
      expect(calls()).toBe(1); // the recorder does hit upstream once, by design
      // The assertion that matters: pre-fix this directory was empty, because
      // the call passed through instead of being recorded.
      const files = await fs.readdir(dir);
      expect(files).toHaveLength(1);
    },
  );

  it("a padded host records the same cassette as the unpadded one", async () => {
    // Stronger than "a file appeared": the recorded artifact must be identical,
    // so trimming cannot be satisfied by intercepting into some other key.
    const body = JSON.stringify({ model: "claude-haiku-4-5", messages: [] });

    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-host-ws-plain-"));
    const plainStore = new CassetteStore({ dir: plainDir });
    const plain = createRecorderFetch({
      upstream: stubUpstream().upstream,
      store: plainStore,
      hosts: new Set(["api.anthropic.com"]),
    });
    await plain("https://api.anthropic.com/v1/messages", { method: "POST", body });

    const padded = createRecorderFetch({
      upstream: stubUpstream().upstream,
      store,
      hosts: new Set(["  api.anthropic.com  "]),
    });
    await padded("https://api.anthropic.com/v1/messages", { method: "POST", body });

    const plainFiles = (await fs.readdir(plainDir)).sort();
    const paddedFiles = (await fs.readdir(dir)).sort();
    expect(paddedFiles).toEqual(plainFiles);
  });

  it("replayer stops reporting 'non-intercepted host' for a padded entry", async () => {
    // Pre-fix the replayer threw `replayer received request to non-intercepted
    // host` for a host the caller HAD listed — loud, but naming the wrong
    // cause and pointing away from the whitespace. It must now report the
    // ordinary missing-cassette error instead.
    const replayer = createReplayerFetch({ store, hosts: new Set([" api.anthropic.com "]) });

    await expect(
      replayer("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/no cassette found/);

    await expect(
      replayer("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    ).rejects.not.toThrow(/non-intercepted host/);
  });

  it("a genuinely different host still passes through unchanged", async () => {
    // The fix must not widen matching beyond whitespace — trimming must not
    // turn an unlisted host into an intercepted one.
    const { upstream, calls } = stubUpstream();
    const recorder = createRecorderFetch({
      upstream,
      store,
      hosts: new Set([" api.anthropic.com "]),
    });

    const res = await recorder("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(calls()).toBe(1);
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(0);
  });

  it("an all-whitespace host is still rejected by validation, not silently trimmed to empty", async () => {
    // `validateHosts` runs before `normalizeHosts`, so "   " is a non-empty
    // string and passes — but trimming it to "" must not produce a Set entry
    // that matches nothing while looking configured. Assert the observable
    // behaviour: it does not intercept, and nothing is recorded.
    const { upstream, calls } = stubUpstream();
    const recorder = createRecorderFetch({ upstream, store, hosts: new Set(["   "]) });

    await recorder("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });

    expect(calls()).toBe(1);
    expect(await fs.readdir(dir)).toHaveLength(0);
  });
});
