/**
 * FormData sent as a `Request` is the same cassette as FormData sent as
 * `init.body` (#231).
 *
 * For a `Request` input the recorder read `clone().arrayBuffer()`: the
 * multipart wire bytes, random undici boundary included. Every run hashed to a
 * new cassette that replay could never find, and a credential field reached the
 * leak scanner as `name="api_key"\r\n\r\n<value>`, which no `key=` pattern
 * matches, so it was sent live and written. The fakes below are built from
 * parts so this file is not itself a leak.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";

const HOSTS = new Set(["api.example.com"]);
const URL_ = "https://api.example.com/v1/files";
// No prefix of its own: only the field name marks it as a credential (#223).
const FAKE_OPAQUE = ["fake", "opaque", "y".repeat(24)].join("");

let dir: string;
let calls: number;

function recorder() {
  const upstream = (async () => {
    calls += 1;
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
}

function replayer() {
  return createReplayerFetch({ store: new CassetteStore({ dir }), hosts: HOSTS });
}

function form(...fields: Array<readonly [string, string | Blob]>): FormData {
  const fd = new FormData();
  for (const [name, value] of fields) fd.append(name, value);
  return fd;
}

const asInit = (fd: FormData) => [URL_, { method: "POST", body: fd }] as const;
const asRequest = (fd: FormData) => [new Request(URL_, { method: "POST", body: fd })] as const;

async function cassettes(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-req-fd-"));
  calls = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a FormData Request hashes its entries, not its boundary (#231)", () => {
  const purpose = () => form(["purpose", "batch"]);
  const withFile = () =>
    form(["purpose", "batch"], ["file", new File(['{"a":1}'], "in.jsonl", { type: "application/jsonl" })]);

  it.each([
    ["a string field", purpose],
    ["a string field and a typed file", withFile],
  ] as const)("recording %s twice as a Request writes one cassette", async (_name, body) => {
    const fetchRec = recorder();
    await fetchRec(...asRequest(body()));
    await fetchRec(...asRequest(body()));
    expect(calls).toBe(2);
    expect(await cassettes()).toHaveLength(1);
  });

  it.each([
    ["a string field", purpose],
    ["a string field and a typed file", withFile],
  ] as const)("%s as a Request and as init.body is one cassette", async (_name, body) => {
    const fetchRec = recorder();
    await fetchRec(...asInit(body()));
    const [initHash] = await cassettes();
    await fetchRec(...asRequest(body()));
    expect(await cassettes()).toEqual([initHash]);
  });

  it("replays across both shapes", async () => {
    await recorder()(...asInit(purpose()));
    const fetchRep = replayer();
    expect(await (await fetchRep(...asRequest(purpose()))).json()).toEqual({ ok: true });
    expect(await (await fetchRep(...asInit(purpose()))).json()).toEqual({ ok: true });
  });

  it("stores the entry records, not the multipart bytes", async () => {
    // Two fields, so the records are not one JSON value and are stored `raw`.
    await recorder()(...asRequest(form(["purpose", "batch"], ["n", "1"])));
    const [file] = await cassettes();
    const cassette = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
    expect(cassette.request.body).toBe(
      [JSON.stringify(["s", "purpose", "batch"]), JSON.stringify(["s", "n", "1"])].join("\n"),
    );
    expect(cassette.request.bodyEncoding).toBe("raw");
  });

  it("still sends the Request's own multipart body upstream (control)", async () => {
    // Parsing reads a clone, so the caller's Request is not consumed.
    let seen: FormData | null = null;
    const upstream = (async (input: RequestInfo | URL) => {
      seen = await (input as Request).formData();
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const fetchRec = createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
    await fetchRec(...asRequest(purpose()));
    expect(seen).not.toBeNull();
    expect([...(seen as unknown as FormData).entries()]).toEqual([["purpose", "batch"]]);
  });
});

describe("a credential in a FormData Request is refused before the live call (#231)", () => {
  it.each([
    ["one api_key field", () => form(["api_key", FAKE_OPAQUE])],
    ["access_token after another field", () => form(["grant_type", "client_credentials"], ["access_token", FAKE_OPAQUE])],
  ] as const)("%s", async (_name, body) => {
    const fetchRec = recorder();
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(fetchRec(...asRequest(body()))).rejects.toThrow("in the request body");
    }
    expect(calls).toBe(0);
    expect(await cassettes()).toHaveLength(0);
  });

  it("the same field through init.body is refused too (control)", async () => {
    await expect(recorder()(...asInit(form(["api_key", FAKE_OPAQUE])))).rejects.toThrow("in the request body");
    expect(calls).toBe(0);
  });

  it("a clean FormData Request records (control)", async () => {
    await recorder()(...asRequest(form(["purpose", "batch"])));
    expect(calls).toBe(1);
    expect(await cassettes()).toHaveLength(1);
  });
});

describe("a Request that is not multipart keeps its byte read (control, #231)", () => {
  it("a JSON Request hashes like the same JSON as init.body", async () => {
    const fetchRec = recorder();
    await fetchRec(URL_, { method: "POST", body: '{"a":1}' });
    await fetchRec(new Request(URL_, { method: "POST", body: '{"a":1}' }));
    expect(await cassettes()).toHaveLength(1);
  });

  it("a multipart content type over bytes that do not parse falls back to the bytes", async () => {
    const headers = { "content-type": "multipart/form-data; boundary=zzz" };
    const fetchRec = recorder();
    await fetchRec(URL_, { method: "POST", headers, body: "not multipart" });
    await fetchRec(new Request(URL_, { method: "POST", headers, body: "not multipart" }));
    expect(calls).toBe(2);
    expect(await cassettes()).toHaveLength(1);
  });
});
