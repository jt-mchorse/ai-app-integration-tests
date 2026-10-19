import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";
import { installRecorder, installReplayer, uninstall } from "../src/install.js";

// A hosts entry that is not a bare hostname is refused (#219).
//
// `shouldIntercept` compares an entry, trimmed and lowercased, with the
// request's `URL.hostname`. #213 refused the blank entry; a port, a scheme, a
// path or a Unicode name the URL parser spells in punycode is non-blank, passed
// both gates, and matched nothing. Measured on main against a local upstream:
// `"127.0.0.1:55023"` and `"http://127.0.0.1:55023"` each recorded with status
// 200 and wrote 0 cassettes, and replay threw "non-intercepted host ... add the
// hostname", which the caller had.
const NOT_BARE: ReadonlyArray<{ host: string; label: string; use: string | null }> = [
  { host: "127.0.0.1:8080", label: "an IPv4 with a port", use: "127.0.0.1" },
  { host: "api.anthropic.com:443", label: "a host with a port", use: "api.anthropic.com" },
  { host: "https://api.anthropic.com", label: "a scheme", use: "api.anthropic.com" },
  { host: "http://127.0.0.1:55023", label: "a scheme and a port", use: "127.0.0.1" },
  { host: "api.anthropic.com/v1", label: "a path", use: "api.anthropic.com" },
  { host: "user@api.anthropic.com", label: "userinfo", use: "api.anthropic.com" },
  { host: "bücher.example", label: "a Unicode name", use: "xn--bcher-kva.example" },
  { host: "::1", label: "a bare IPv6", use: "[::1]" },
  { host: "a b.example", label: "a space inside", use: null },
  // #225: parsed as a hostname, matched as a literal.
  { host: "*.anthropic.com", label: "a subdomain wildcard", use: null },
  { host: "*", label: "a bare wildcard", use: null },
  { host: "https://*.anthropic.com", label: "a wildcard behind a scheme", use: null },
  { host: "api.*.com", label: "a wildcard label in the middle", use: null },
];

const BARE: ReadonlyArray<{ host: string; label: string }> = [
  { host: "api.anthropic.com", label: "a hostname" },
  { host: "API.Anthropic.com", label: "mixed case" },
  { host: " api.anthropic.com\t", label: "padding (#95)" },
  { host: "127.0.0.1", label: "an IPv4" },
  { host: "[::1]", label: "a bracketed IPv6" },
  { host: "xn--bcher-kva.example", label: "a punycode name" },
];

describe("a hosts entry must be the hostname requests are matched on (#219)", () => {
  let dir: string;
  let store: CassetteStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-host-shape-"));
    store = new CassetteStore({ dir });
  });

  afterEach(() => {
    uninstall();
  });

  it.each(NOT_BARE)("all four entry points refuse $label", ({ host, use }) => {
    const hint =
      use === null ? "" : `.*; use ${JSON.stringify(use).replace(/[.[\]]/g, "\\$&")}$`;
    const quoted = JSON.stringify(host).replace(/[.[\]/*]/g, "\\$&");
    expect(() => createRecorderFetch({ store, hosts: new Set([host]) })).toThrow(
      new RegExp(`createRecorderFetch: hosts entry #0 ${quoted} is not a.*${hint}`),
    );
    expect(() => createReplayerFetch({ store, hosts: new Set([host]) })).toThrow(
      new RegExp(`createReplayerFetch: hosts entry #0 ${quoted} is not a.*${hint}`),
    );
    expect(() => installRecorder({ fixturesDir: dir, hosts: [host] })).toThrow(
      new RegExp(`installRecorder: hosts\\[0\\] ${quoted} is not a.*${hint}`),
    );
    expect(() => installReplayer({ fixturesDir: dir, hosts: [host] })).toThrow(
      new RegExp(`installReplayer: hosts\\[0\\] ${quoted} is not a.*${hint}`),
    );
  });

  it.each(NOT_BARE.filter(({ host }) => host.includes("*")))(
    "$label is refused as a wildcard, not given a hostname to use (#225)",
    ({ host }) => {
      const wildcard = /hosts are matched exactly and wildcards are not supported.*; list each hostname$/;
      expect(() => createRecorderFetch({ store, hosts: new Set([host]) })).toThrow(wildcard);
      expect(() => createReplayerFetch({ store, hosts: new Set([host]) })).toThrow(wildcard);
      expect(() => installRecorder({ fixturesDir: dir, hosts: [host] })).toThrow(wildcard);
      expect(() => installReplayer({ fixturesDir: dir, hosts: [host] })).toThrow(wildcard);
    },
  );

  it.each(BARE)("$label is still accepted everywhere", ({ host }) => {
    expect(() => createRecorderFetch({ store, hosts: new Set([host]) })).not.toThrow();
    expect(() => createReplayerFetch({ store, hosts: new Set([host]) })).not.toThrow();
    expect(() => installRecorder({ fixturesDir: dir, hosts: [host] })).not.toThrow();
    uninstall();
    expect(() => installReplayer({ fixturesDir: dir, hosts: [host] })).not.toThrow();
  });

  it("the suggested hostname records and replays where the refused entry went live", async () => {
    let calls = 0;
    const upstream: typeof fetch = async () => {
      calls += 1;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const url = "http://127.0.0.1:8080/v1/x";
    expect(() => createRecorderFetch({ upstream, store, hosts: new Set(["127.0.0.1:8080"]) })).toThrow(
      /use "127\.0\.0\.1"/,
    );
    const recorder = createRecorderFetch({ upstream, store, hosts: new Set(["127.0.0.1"]) });
    await recorder(url, { method: "POST", body: '{"a":1}' });
    expect(calls).toBe(1);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    const replayer = createReplayerFetch({ store, hosts: new Set(["127.0.0.1"]) });
    const res = await replayer(url, { method: "POST", body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});
