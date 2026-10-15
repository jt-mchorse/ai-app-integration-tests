import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";
import { installRecorder, installReplayer, uninstall } from "../src/install.js";

// A hosts entry that is ONLY whitespace (#213).
//
// Both `validateHosts` gates (#26 installer, #34 factory) refused `""` but
// tested the raw string's length, while `normalizeHosts` (#95) matches on the
// TRIMMED string. So `"   "` passed validation, became `""`, and matched no
// hostname: the recorder called the live upstream and wrote no cassette, with
// no error -- `""`'s exact behaviour, behind an entry that looked configured.
// `RECORD_HOSTS=" "` split on "," is the realistic source.
//
// Built from codepoints: every one of these is whitespace `String.prototype.trim`
// removes, which is the set `normalizeHosts` turns into "".
const ch = (...cps: number[]) => String.fromCodePoint(...cps);
const BLANK: ReadonlyArray<{ host: string; label: string }> = [
  { host: ch(0x20), label: "one space" },
  { host: ch(0x20, 0x20, 0x20), label: "three spaces" },
  { host: ch(0x09), label: "a tab" },
  { host: ch(0x0a), label: "a newline" },
  { host: ch(0x20, 0x0d, 0x0a), label: "space + CRLF" },
  { host: ch(0xa0), label: "a no-break space" },
  { host: ch(0xfeff), label: "a BOM" },
];

const URL_ = "https://api.anthropic.com/v1/messages";

function stubUpstream(): { upstream: typeof fetch; calls: () => number } {
  let n = 0;
  const upstream: typeof fetch = async () => {
    n += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { upstream, calls: () => n };
}

describe("a whitespace-only hosts entry is refused (#213)", () => {
  let dir: string;
  let store: CassetteStore;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-host-blank-"));
    store = new CassetteStore({ dir });
  });

  afterEach(() => {
    uninstall();
    globalThis.fetch = realFetch;
  });

  it.each(BLANK)("createRecorderFetch refuses $label", ({ host }) => {
    const { upstream } = stubUpstream();
    expect(() => createRecorderFetch({ upstream, store, hosts: new Set([host]) })).toThrow(
      /createRecorderFetch: hosts entry #0 must be a non-empty string; got .* \(blank once trimmed/,
    );
  });

  it.each(BLANK)("createReplayerFetch refuses $label", ({ host }) => {
    expect(() => createReplayerFetch({ store, hosts: new Set([host]) })).toThrow(
      /createReplayerFetch: hosts entry #0 must be a non-empty string; got .* \(blank once trimmed/,
    );
  });

  it.each(BLANK)("installRecorder refuses $label", ({ host }) => {
    expect(() => installRecorder({ fixturesDir: dir, hosts: [host] })).toThrow(
      /installRecorder: hosts\[0\] must be a non-empty string; got .* \(blank once trimmed/,
    );
  });

  it.each(BLANK)("installReplayer refuses $label", ({ host }) => {
    expect(() => installReplayer({ fixturesDir: dir, hosts: [host] })).toThrow(
      /installReplayer: hosts\[0\] must be a non-empty string; got .* \(blank once trimmed/,
    );
  });

  it("a blank entry beside a valid one is refused, naming its index", () => {
    expect(() => installRecorder({ fixturesDir: dir, hosts: ["api.anthropic.com", "  "] })).toThrow(
      /installRecorder: hosts\[1\] must be a non-empty string; got "  "/,
    );
    const { upstream } = stubUpstream();
    expect(() =>
      createRecorderFetch({ upstream, store, hosts: new Set(["api.anthropic.com", "  "]) }),
    ).toThrow(/hosts entry #1 must be a non-empty string; got "  "/);
  });

  it("the refusal happens before any call can reach the live upstream", async () => {
    // The harm, measured on the artifact: on the unfixed tree this install
    // succeeded, the fetch below went upstream, and the directory stayed empty.
    const { upstream, calls } = stubUpstream();
    globalThis.fetch = upstream;
    let installed = true;
    try {
      installRecorder({ fixturesDir: dir, hosts: ["   "] });
    } catch {
      installed = false;
    }
    if (installed) await globalThis.fetch(URL_, { method: "POST", body: "{}" });
    expect(installed).toBe(false);
    expect(calls()).toBe(0);
    expect(await fs.readdir(dir)).toHaveLength(0);
  });

  it("an empty string keeps its message without the trimmed note", () => {
    expect(() => installRecorder({ hosts: [""] })).toThrow(/hosts\[0\] must be a non-empty string; got ""$/);
  });

  it("a padded real host is still accepted and records (#95 unchanged)", async () => {
    const { upstream, calls } = stubUpstream();
    const recorder = createRecorderFetch({ upstream, store, hosts: new Set([" api.anthropic.com\t"]) });
    await recorder(URL_, { method: "POST", body: "{}" });
    expect(calls()).toBe(1);
    expect(await fs.readdir(dir)).toHaveLength(1);
  });
});
