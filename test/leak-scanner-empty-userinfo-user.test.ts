/**
 * A connection string with an empty username is refused (#263).
 *
 * The URL-userinfo pattern was `//[^/@\s:]+:[^/@\s]+@`, which needs a username.
 * RFC 3986 §3.2.1 lets it be empty, and `redis://:password@host` is the ordinary
 * Redis/AMQP form for a password with no user. Those passwords are often under
 * the 24 characters the `password` name rule needs, so a request body carrying
 * `REDIS_URL=rediss://:<pw>@cache…` went out live and was written to disk,
 * while the same URL with `default:` in front was refused.
 *
 * Out of scope: a token used as the username with no `:`
 * (`https://<token>@github.com`). `ssh://git@github.com` has that shape and must
 * still record, so it is a separate call; the control below pins it.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";
import { CassetteStore, createRecorderFetch } from "../src/index.js";

// Built from parts so this file is not a leak. 10 chars: under the name rule's 24.
const PW = ["Zq8x", "Lm2Pw9"].join("");

function cassette(body: unknown): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "0".repeat(32),
    request: { method: "POST", url: "https://api.example.com/v1", headers: {}, body },
    response: { kind: "non_streaming", status: 200, headers: {}, body: '{"ok":true}' },
    recorded_at: "2026-10-29T00:00:00Z",
  } as CassetteV1;
}

const EMPTY_USER: Array<readonly [string, string]> = [
  ["redis", `redis://:${PW}@cache.example.com:6379`],
  ["rediss with a db index", `rediss://:${PW}@cache.example.com:6380/0`],
  ["amqp", `amqp://:${PW}@mq.example.com`],
  ["amqps with a vhost", `amqps://:${PW}@mq.example.com/vhost`],
  ["mongodb", `mongodb://:${PW}@db.example.com:27017/app`],
  ["a percent-encoded password", `redis://:${encodeURIComponent(`${PW}#!`)}@cache.example.com`],
  ["a password holding a colon", `redis://:${PW}:x@cache.example.com`],
];

describe("an empty-username connection string is refused (#263)", () => {
  it.each(EMPTY_USER)("JSON body: %s", (_label, url) => {
    expect(() => assertNoLeakedSecrets(cassette({ url }))).toThrow(/unredacted secret/);
  });

  it.each(EMPTY_USER)("env-style string body: %s", (_label, url) => {
    expect(() => assertNoLeakedSecrets(cassette(`REDIS_URL=${url}\n`))).toThrow(/unredacted secret/);
  });

  it("control: the same password with a username was already refused", () => {
    expect(() =>
      assertNoLeakedSecrets(cassette({ url: `redis://default:${PW}@cache.example.com:6379` })),
    ).toThrow(/unredacted secret/);
  });

  it.each([
    ["a username and an empty password", "redis://user:@cache.example.com"],
    ["an empty username and an empty password", "redis://:@cache.example.com"],
    ["a username with no password (ssh://git@)", "ssh://git@github.com/o/r.git"],
    ["a plain URL with a port", "redis://cache.example.com:6379/0"],
    ["a timestamp and an email beside a URL", "12:30 a@b.com https://example.com/x"],
  ])("control: %s is not a credential", (_label, text) => {
    expect(() => assertNoLeakedSecrets(cassette({ text }))).not.toThrow();
  });
});

let dir: string;
let calls: number;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-empty-user-"));
  calls = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the recorder refuses an empty-username connection string before the live call (#263)", () => {
  it("is refused with no upstream call and nothing written", async () => {
    const upstream = (async () => {
      calls += 1;
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const record = createRecorderFetch({
      upstream,
      store: new CassetteStore({ dir }),
      hosts: new Set(["api.anthropic.com"]),
    });
    const body = JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 16,
      messages: [{ role: "user", content: `REDIS_URL=rediss://:${PW}@cache.example.com:6380` }],
    });
    await expect(
      record("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    ).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });
});
