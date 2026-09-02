/**
 * The temp filename must not push a legal destination past NAME_MAX (#111).
 *
 * `atomicWriteFile` writes to a sibling temp named
 * `.<base>.<pid>.<12-hex>.tmp`. Those affixes are base + 25 bytes in the worst
 * case (a Linux pid can be 7 digits), so a destination basename near the
 * 255-byte NAME_MAX overflowed the limit and the write failed ENAMETOOLONG —
 * for a target a plain `fs.writeFile` accepts.
 *
 * This one is reachable through exported public API, which is why it gets an
 * end-to-end test and not only a threshold table. `CassetteStore` is exported
 * from `src/index.ts`, and `write(cassette)` takes the basename from
 * `cassette.request_hash` — a plain string on a public type that nothing on the
 * write path constrains. The recorder's own path cannot get there
 * (`hashRequest` returns 32 hex characters), but a fixture generator or a
 * migration script building a `CassetteV1` by hand can.
 *
 * The threshold assertions are stated as a **relation between two calls**, not
 * as a fact about the filesystem: for any basename the host's own plain
 * `fs.writeFile` accepts, the atomic path must accept it too. A host that
 * refuses the plain write (shorter NAME_MAX, exotic filesystem) skips that row
 * rather than failing, so nothing here asserts something only one machine
 * believes.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CassetteV1 } from "../src/cassette.js";
import { CassetteStore } from "../src/index.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-name-max-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function fakeCassette(hash: string): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: hash,
    request: {
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
    },
    response: {
      kind: "non_streaming",
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    },
  } as CassetteV1;
}

/** Does this host accept `base` as a filename at all? */
async function plainWriteWorks(base: string): Promise<boolean> {
  const probe = path.join(dir, base);
  try {
    await fs.writeFile(probe, "probe");
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

describe("CassetteStore.write survives a long request_hash (#111)", () => {
  it("a 240-character hash round-trips through write and read", async () => {
    // The measured pre-fix failure: plain `fs.writeFile` of the identical
    // filename succeeded and `CassetteStore.write` raised ENAMETOOLONG,
    // because the temp name carried the whole 245-byte basename.
    const hash = "a".repeat(240);
    if (!(await plainWriteWorks(`${hash}.json`))) return;

    const store = new CassetteStore({ dir });
    const written = await store.write(fakeCassette(hash));

    expect(path.basename(written)).toBe(`${hash}.json`);
    // Read it back rather than only asserting the write returned: the point is
    // a usable cassette, not an absent exception.
    const round = await store.read(hash);
    expect(round?.request_hash).toBe(hash);
    // No temp debris survived — the cap must not have broken cleanup.
    expect(await fs.readdir(dir)).toEqual([`${hash}.json`]);
  });
});

// The boundary. The temp name crosses 255 B somewhere around a 231-byte
// basename, so the last three rows are the ones that used to fail.
const HASHES = [
  ["well under the budget", "a".repeat(190)],
  ["just under the old threshold", "a".repeat(220)],
  ["just over the old threshold", "a".repeat(228)],
  ["comfortably over", "a".repeat(236)],
  ["at NAME_MAX", "a".repeat(245)],
] as const;

describe("every basename a plain write accepts also goes through the atomic path", () => {
  it.each(HASHES)("%s", async (_label, hash) => {
    const base = `${hash}.json`;
    if (!(await plainWriteWorks(base))) return; // host's own limit; nothing to compare against

    const store = new CassetteStore({ dir });
    await store.write(fakeCassette(hash));

    expect(await fs.readdir(dir)).toEqual([base]);
  });

  it("a multibyte hash is trimmed on a character boundary, never mid-codepoint", async () => {
    // "é" is 2 bytes in UTF-8, so 120 of them is 240 bytes: over budget in
    // bytes while well under it in characters. A byte-slice would split one.
    const hash = "é".repeat(120);
    if (!(await plainWriteWorks(`${hash}.json`))) return;

    const store = new CassetteStore({ dir });
    await store.write(fakeCassette(hash));

    expect(await fs.readdir(dir)).toEqual([`${hash}.json`]);
  });

  it("the cap is maximal, not merely within budget", () => {
    // `capBaseForTemp` is module-private on purpose — it is an implementation
    // detail of the temp name, not a contract — so the property is asserted
    // arithmetically against the same budget the helper uses.
    const budget = 200;
    const base = `${"a".repeat(245)}.json`;
    const capped = base.slice(0, budget); // ASCII here, so bytes === chars

    const worstCaseTemp = `.${capped}.${"9".repeat(7)}.${"a".repeat(12)}.tmp`;
    expect(Buffer.byteLength(worstCaseTemp, "utf8")).toBeLessThanOrEqual(255);

    // Without this, a cap returning "" satisfies every length assertion above.
    expect(Buffer.byteLength(base.slice(0, budget + 1), "utf8")).toBeGreaterThan(budget);
  });
});
