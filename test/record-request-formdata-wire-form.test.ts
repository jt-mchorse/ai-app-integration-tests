/**
 * FormData whose multipart wire form rewrites it is still one cassette across
 * `Request` and `init.body` (#233, D-016).
 *
 * After #231 a FormData `Request` is parsed back and hashed by the same entry
 * records as `init.body`. The wire form converts a bare CR or LF in a string
 * value to CRLF, and sends an untyped file as `application/octet-stream`. A
 * `Request` can only be read back in that form, so `init.body` recorded
 * `"a\nb"` / `""` and the `Request` recorded `"a\r\nb"` /
 * `"application/octet-stream"`: two cassettes for one wire request, and replay
 * across the shapes threw `MissingCassetteError`.
 *
 * Field names and filenames are percent-escaped on the wire, and Node 20's
 * parser reads the escape back literally where Node 22+ decodes it, so a
 * `Request`'s name record depends on the runtime. Their canonical form is the
 * open part of #233; the controls below pin that this change leaves them as
 * they were.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";

const HOSTS = new Set(["api.example.com"]);
const URL_ = "https://api.example.com/v1/files";

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

async function storedBody(): Promise<unknown> {
  const [file] = await cassettes();
  return JSON.parse(await fs.readFile(path.join(dir, file), "utf8")).request.body;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-fd-wire-"));
  calls = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// Each of these is rewritten on the wire, so it was two cassettes before #233.
const REWRITTEN = [
  ["a bare LF in a value", () => form(["s", "a\nb"])],
  ["a bare CR in a value", () => form(["s", "a\rb"])],
  ["an LF then CR in a value", () => form(["s", "a\n\rb"])],
  ["an untyped file", () => form(["f", new Blob(["x"])])],
] as const;

describe("a FormData body the wire rewrites is one cassette across both shapes (#233)", () => {
  it.each(REWRITTEN)("%s as init.body and as a Request is one cassette", async (_name, body) => {
    const fetchRec = recorder();
    await fetchRec(...asInit(body()));
    await fetchRec(...asRequest(body()));
    expect(calls).toBe(2);
    expect(await cassettes()).toHaveLength(1);
  });

  it.each(REWRITTEN)("%s recorded as init.body replays as a Request", async (_name, body) => {
    await recorder()(...asInit(body()));
    expect(await (await replayer()(...asRequest(body()))).json()).toEqual({ ok: true });
  });

  it("records a value and an untyped file in their wire form", async () => {
    await recorder()(...asInit(form(["s", "a\nb"], ["f", new Blob(["blob"])])));
    expect(await storedBody()).toBe(
      [
        JSON.stringify(["s", "s", "a\r\nb"]),
        JSON.stringify(["f", "f", "blob", "application/octet-stream", "blob"]),
      ].join("\n"),
    );
  });
});

describe("what the wire does not rewrite keeps its record and its hash (controls, #233)", () => {
  // Captured from the code before #233: none of these bodies is rewritten on
  // the wire, so the normalization must not move a committed cassette.
  it.each([
    ["a string field", () => form(["purpose", "batch"]), "2de025900d4647e954e49efdd9eee7d3.json"],
    ["a CRLF value", () => form(["s", "a\r\nb"]), "b8074eb849d65d7428928ddfdc23305a.json"],
    [
      "a typed file",
      () => form(["file", new File(['{"a":1}'], "in.jsonl", { type: "application/jsonl" })]),
      "43fae9ebfc2964fb57bdf015739fb219.json",
    ],
    [
      "a newline in a filename",
      () => form(["f", new File(["x"], "a\nb.txt", { type: "text/plain" })]),
      "ace30e72d7e5b27aa23ed87557500b9d.json",
    ],
    [
      "a binary typed file",
      () => form(["f", new File([new Uint8Array([0xff, 0xfe])], "b.bin", { type: "application/octet-stream" })]),
      "5a8e804749467b78b08d85cc1dfa3943.json",
    ],
    [
      "a newline inside file bytes",
      () => form(["f", new File(["a\nb"], "a.txt", { type: "text/plain" })]),
      "ba3520e5b15038ab04b49e5fbe3d517b.json",
    ],
    // A field name is not converted (the open part of #233).
    ["a bare LF in a field name", () => form(["n\nm", "v"]), "f81a369be99353a188704cc50c771a3f.json"],
  ] as const)("%s hashes as before", async (_name, body, hash) => {
    await recorder()(...asInit(body()));
    expect(await cassettes()).toEqual([hash]);
  });

  it("a field name, a filename and a file's bytes are recorded unconverted", async () => {
    // File bytes are never rewritten; names and filenames are the open part of
    // #233. One record is one JSON value, so the cassette stores it parsed.
    await recorder()(...asInit(form(["f\nx", new File(["a\nb"], "a\nb.txt", { type: "text/plain" })])));
    expect(await storedBody()).toEqual(["f", "f\nx", "a\nb.txt", "text/plain", "a\nb"]);
  });

  it("the caller's FormData still goes upstream unconverted", async () => {
    let seen: Array<[string, FormDataEntryValue]> = [];
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = [...(init?.body as FormData).entries()];
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const fetchRec = createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
    await fetchRec(...asInit(form(["s", "a\nb"], ["f", new Blob(["x"])])));
    expect(seen[0]).toEqual(["s", "a\nb"]);
    expect((seen[1][1] as File).type).toBe("");
  });
});
