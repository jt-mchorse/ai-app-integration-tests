/**
 * A hand-built multipart `Request` keeps its byte read; only undici's own
 * FormData serialization is parsed into fields (#235, regression from #234).
 *
 * #234 parsed every `multipart/form-data` Request back into FormData. Parsing
 * drops a preamble and each part's own headers, so two hand-built bodies that
 * differ only there were one cassette and replay served the other's response,
 * and the same fixed-boundary bytes as an `init` string and as a `Request`
 * split into two cassettes, undoing #143's parity -- and moving every cassette
 * recorded for such a Request before #234.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";

const HOSTS = new Set(["api.example.com"]);
const URL_ = "https://api.example.com/v1/files";
const BOUNDARY = "fixedboundary235";
const HEADERS = { "content-type": `multipart/form-data; boundary=${BOUNDARY}` };

let dir: string;
let calls: number;

/** One string field `x`, with an optional part Content-Type and preamble. */
function multipart(boundary: string, opts: { partType?: string; preamble?: string } = {}): string {
  const typeLine = opts.partType === undefined ? "" : `Content-Type: ${opts.partType}\r\n`;
  return (
    `${opts.preamble ?? ""}--${boundary}\r\n` +
    `Content-Disposition: form-data; name="x"\r\n${typeLine}\r\nhello\r\n` +
    `--${boundary}--\r\n`
  );
}

/** Echoes back what told this request apart, so a wrong replay is visible. */
function recorder() {
  const upstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const text = await new Request(input as RequestInfo, init).text();
    const servedFor = /Content-Type: (\S+)/.exec(text)?.[1] ?? (text.startsWith("--") ? "none" : "preamble");
    return new Response(JSON.stringify({ served_for: servedFor }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
}

function replayer() {
  return createReplayerFetch({ store: new CassetteStore({ dir }), hosts: HOSTS });
}

const asRequest = (body: string, headers: Record<string, string> = HEADERS) =>
  new Request(URL_, { method: "POST", headers, body });

async function cassettes(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-req-mp-"));
  calls = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("hand-built multipart Requests that differ are two cassettes (#235)", () => {
  it.each([
    [
      "only in a part's Content-Type",
      multipart(BOUNDARY, { partType: "application/json" }),
      multipart(BOUNDARY, { partType: "text/plain" }),
      "application/json",
    ],
    ["only in a preamble", multipart(BOUNDARY, { preamble: "preamble\r\n" }), multipart(BOUNDARY), "preamble"],
  ] as const)("%s: replay serves each its own response", async (_name, a, b, aServedFor) => {
    const fetchRec = recorder();
    await fetchRec(asRequest(a));
    await fetchRec(asRequest(b));
    expect(calls).toBe(2);
    expect(await cassettes()).toHaveLength(2);
    expect(await (await replayer()(asRequest(a))).json()).toEqual({ served_for: aServedFor });
  });

  it("an undici-shaped boundary over a body that does not round-trip keeps its bytes", async () => {
    // Copies undici's boundary FORM, but a part Content-Type undici never
    // writes for a string field: the parse would lose it, so it is not parsed.
    const boundary = "----formdata-undici-012345678901";
    const headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
    const fetchRec = recorder();
    await fetchRec(asRequest(multipart(boundary, { partType: "application/json" }), headers));
    await fetchRec(asRequest(multipart(boundary, { partType: "text/plain" }), headers));
    expect(await cassettes()).toHaveLength(2);
  });
});

describe("fixed-boundary bytes hash as bytes again (#235)", () => {
  it("as an init string and as a Request is one cassette (#143 parity)", async () => {
    const body = multipart(BOUNDARY, { partType: "application/json" });
    const fetchRec = recorder();
    await fetchRec(URL_, { method: "POST", headers: HEADERS, body });
    await fetchRec(asRequest(body));
    expect(calls).toBe(2);
    expect(await cassettes()).toHaveLength(1);
  });

  it("stores the multipart bytes, not entry records", async () => {
    const body = multipart(BOUNDARY);
    await recorder()(asRequest(body));
    const [file] = await cassettes();
    const cassette = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
    expect(cassette.request.body).toBe(body);
  });

  it("a cassette recorded before #234 still replays", async () => {
    // Written by the pre-#234 recorder (43cd2b8) for this exact Request and
    // copied here verbatim: its name is the hash of the raw bytes. Nothing is
    // recorded in this test, so only the lookup is under test.
    const body = multipart(BOUNDARY, { partType: "application/json" });
    const hash = "4582dae075cda5dc77e29195300e622a";
    const cassette = {
      schema_version: "1",
      request_hash: hash,
      request: { method: "POST", url: URL_, headers: HEADERS, body, bodyEncoding: "raw" },
      response: {
        kind: "non_streaming",
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"served_for":"application/json"}',
      },
      recorded_at: "2026-10-20T08:17:05.472Z",
    };
    await fs.writeFile(path.join(dir, `${hash}.json`), JSON.stringify(cassette, null, 2));
    expect(await (await replayer()(asRequest(body))).json()).toEqual({ served_for: "application/json" });
  });
});

describe("undici's own FormData serialization is still parsed (control, #231)", () => {
  it("two FormData Requests with fresh random boundaries are one cassette", async () => {
    const form = () => {
      const fd = new FormData();
      fd.append("purpose", "batch");
      fd.append("file", new File([new Uint8Array([0xff, 0x00, 0xfe])], "in.bin", { type: "application/octet-stream" }));
      return fd;
    };
    const fetchRec = recorder();
    await fetchRec(new Request(URL_, { method: "POST", body: form() }));
    await fetchRec(new Request(URL_, { method: "POST", body: form() }));
    expect(calls).toBe(2);
    expect(await cassettes()).toHaveLength(1);
  });
});
