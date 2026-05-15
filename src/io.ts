import { promises as fs } from "node:fs";
import path from "node:path";

import { type CassetteV1 } from "./cassette.js";

export interface CassetteStoreOptions {
  /** Directory where `<hash>.json` files live. Default: `./fixtures`. */
  dir: string;
}

export class CassetteStore {
  constructor(private readonly opts: CassetteStoreOptions) {}

  async write(cassette: CassetteV1): Promise<string> {
    await fs.mkdir(this.opts.dir, { recursive: true });
    const filePath = this.pathFor(cassette.request_hash);
    const json = JSON.stringify(cassette, null, 2) + "\n";
    await fs.writeFile(filePath, json, "utf8");
    return filePath;
  }

  async read(requestHash: string): Promise<CassetteV1 | null> {
    const filePath = this.pathFor(requestHash);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as CassetteV1;
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
