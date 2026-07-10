import { randomBytes } from "node:crypto";
import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";

import { type CassetteV1 } from "./cassette.js";

export interface CassetteStoreOptions {
  /** Directory where `<hash>.json` files live. Default: `./fixtures`. */
  dir: string;
}

export class CassetteStore {
  constructor(private readonly opts: CassetteStoreOptions) {}

  async write(cassette: CassetteV1): Promise<string> {
    const filePath = this.pathFor(cassette.request_hash);
    const json = JSON.stringify(cassette, null, 2) + "\n";
    await atomicWriteFile(filePath, Buffer.from(json, "utf-8"));
    return filePath;
  }

  async read(requestHash: string): Promise<CassetteV1 | null> {
    const filePath = this.pathFor(requestHash);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const decoded: unknown = JSON.parse(raw);
      // `JSON.parse` succeeds for `null`, arrays, strings, and numbers, but the
      // integrity guards below dereference `.schema_version`. A top-level `null`
      // (a plausible partial-write / hand-edit artifact) would throw a cryptic
      // `TypeError: Cannot read properties of null` instead of the clean,
      // actionable error the other primitives already get — and must NOT be
      // confused with the ENOENT `null` return that means "no cassette" (#62).
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        const kind = decoded === null ? "null" : Array.isArray(decoded) ? "array" : typeof decoded;
        throw new Error(
          `cassette ${requestHash}.json did not parse to a cassette object (got ${kind}); refusing to use it`,
        );
      }
      const parsed = decoded as CassetteV1;
      if (parsed.schema_version !== "1") {
        throw new Error(
          `cassette ${requestHash} has schema_version ${parsed.schema_version}; this loader only understands "1"`,
        );
      }
      if (parsed.request_hash !== requestHash) {
        // Guard against accidental rename: if the file was renamed but the
        // hash inside no longer matches, replay would silently serve the wrong
        // response.
        throw new Error(
          `cassette filename ${requestHash}.json contains request_hash ${parsed.request_hash}; refusing to use it`,
        );
      }
      // The top-level guard above (#62) only proves `parsed` is an object; the
      // nested `response` is still unchecked, and `rebuildResponse` dereferences
      // `response.headers` (Object.entries), `response.kind`, and — for an SSE
      // cassette — `response.frames` (for...of). A present-but-wrong-typed
      // `response`/`headers`/`frames` (a partial-write or hand-edit artifact)
      // otherwise threw the same cryptic `TypeError` #62 set out to eliminate,
      // one seam over. Validate the shape here so a malformed response fails
      // with the same clean, actionable "refusing to use it" Error (#77).
      assertValidResponse(parsed.response, requestHash);
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  pathFor(requestHash: string): string {
    return path.join(this.opts.dir, `${requestHash}.json`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Validate the recorded `response` shape that `rebuildResponse` will dereference
// (fetch-recorder.ts): a non-null `headers` object plus, per the `kind`
// discriminant, a string `body` (non_streaming) or an array `frames` (sse). A
// malformed cassette fails with a clean, actionable Error mirroring the #62
// top-level guard — never a raw TypeError at replay (#77).
function assertValidResponse(response: unknown, requestHash: string): void {
  const bad = (detail: string): never => {
    throw new Error(`cassette ${requestHash}.json has a malformed response (${detail}); refusing to use it`);
  };
  if (!isObject(response)) {
    bad(`response must be an object, got ${response === null ? "null" : Array.isArray(response) ? "array" : typeof response}`);
    return;
  }
  if (!isObject(response.headers)) {
    bad(`response.headers must be an object, got ${response.headers === null ? "null" : Array.isArray(response.headers) ? "array" : typeof response.headers}`);
  }
  if (response.kind === "non_streaming") {
    if (typeof response.body !== "string") {
      bad(`non_streaming response.body must be a string, got ${typeof response.body}`);
    }
  } else if (response.kind === "sse") {
    if (!Array.isArray(response.frames)) {
      bad(`sse response.frames must be an array, got ${response.frames === null ? "null" : typeof response.frames}`);
    }
  } else {
    bad(`response.kind must be "non_streaming" or "sse", got ${JSON.stringify(response.kind)}`);
  }
}

// `fs.promises.writeFile` is not atomic (#28): SIGINT/SIGTERM/OOM
// mid-write leaves the destination zero-length or partial. For
// cassette replay (the load-bearing contract behind this whole
// repo's test reliability) a partial JSON can either crash with a
// cryptic `JSONDecodeError` or — if the truncation lands after both
// `schema_version` and `request_hash` were written — silently parse
// to a missing-fields object that escapes the existing replay guards.
//
// Pattern matches the cross-language siblings landed in the same
// session: `mcp-server-cookbook/servers/filesystem-sandbox/src/atomic_write.ts`
// (#36 there) and the four Python repos' `atomic_write_text`
// helpers (`llm-eval-harness#48`, `llm-cost-optimizer#42`,
// `prompt-regression-suite#39`, `rag-production-kit#44`).
//
// The temp file lives in the destination's parent directory so the
// rename is same-filesystem — `fs.rename` is atomic on POSIX within
// the same filesystem; cross-filesystem rename degrades to a copy.
async function atomicWriteFile(target: string, data: Buffer): Promise<void> {
  const dir = path.dirname(target);
  const base = path.basename(target);
  await fs.mkdir(dir, { recursive: true });

  const token = randomBytes(6).toString("hex");
  const tmp = path.join(dir, `.${base}.${process.pid}.${token}.tmp`);

  // O_EXCL — collide-loudly with any concurrent process attempt.
  const handle = await fs.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
  let renamed = false;
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await fs.rename(tmp, target);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await handle.close();
      } catch {
        // Already closed or never opened cleanly; nothing further we can do.
      }
      try {
        await fs.unlink(tmp);
      } catch {
        // Temp may already be gone (lost a race with another cleanup, or
        // rename succeeded after a later failure). Either way nothing to do.
      }
    }
  }
}
