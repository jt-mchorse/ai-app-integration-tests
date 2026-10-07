/**
 * A secret the request already shows is refused before the live call (#159).
 *
 * `assertNoLeakedSecrets` ran only after `upstream(...)`, so a key in the URL,
 * an unredacted header or the body cost a real request -- billed, and with a
 * POST's side effects -- on every attempt, before the recording was refused.
 * The fakes below are built from parts so this file is not itself a leak.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, createRecorderFetch } from "../src/index.js";

const FAKE_KEY = ["sk", "ant", "x".repeat(40)].join("-");
const HOSTS = new Set(["api.example.com"]);

let dir: string;
let calls: number;
let responseBody: string;

function recorder() {
  const upstream = (async () => {
    calls += 1;
    return new Response(responseBody, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
}

async function written(): Promise<number> {
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).length;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-preflight-"));
  calls = 0;
  responseBody = '{"ok":true}';
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("request-side secrets are refused with zero upstream calls (#159)", () => {
  it.each([
    ["the request URL", () => [`https://api.example.com/v1/messages?key=${FAKE_KEY}`, { method: "GET" }]],
    [
      "the request headers",
      () => ["https://api.example.com/v1/messages", { method: "POST", headers: { "x-custom-token": FAKE_KEY }, body: "{}" }],
    ],
    [
      "the request body",
      () => ["https://api.example.com/v1/messages", { method: "POST", body: JSON.stringify({ api_key: FAKE_KEY }) }],
    ],
  ] as const)("in %s", async (where, args) => {
    const fetchRec = recorder();
    const [url, init] = args();
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(fetchRec(url, init as RequestInit)).rejects.toThrow(`in ${where}`);
    }
    expect(calls).toBe(0);
    expect(await written()).toBe(0);
  });

  it("a secret only the response carries is still refused, after the one call", async () => {
    responseBody = JSON.stringify({ echoed: FAKE_KEY });
    await expect(recorder()("https://api.example.com/v1/messages", { method: "POST", body: "{}" })).rejects.toThrow(
      "in the response;",
    );
    expect(calls).toBe(1);
    expect(await written()).toBe(0);
  });

  it("a clean request records normally", async () => {
    const res = await recorder()("https://api.example.com/v1/messages", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
    expect(await written()).toBe(1);
  });
});
