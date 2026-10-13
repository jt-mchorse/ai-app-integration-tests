/**
 * The timeout message names the falsy value the predicate last returned (#185).
 *
 * A wait times out only on a falsy reading, so "last value: ..." only ever
 * shows one of JavaScript's eight falsy values, and four of them printed as
 * another: NaN as `null`, `-0` and `0n` as `0`, `""` as nothing. A NaN reading
 * usually means an upstream parse failed, the signal this message exists for.
 */
import { describe, expect, it } from "vitest";

import { WaitTimeoutError, waitFor } from "../src/support/wait-for.js";

const FALSY: Array<[string, unknown]> = [
  ["false", false],
  ["null", null],
  ["undefined", undefined],
  ["0", 0],
  ["-0", -0],
  ["0n", 0n],
  ["NaN", Number.NaN],
  ['""', ""],
];

async function messageFor(value: unknown): Promise<string> {
  let t = 0;
  const err = await waitFor(() => value, {
    timeoutMs: 10,
    intervalMs: 5,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WaitTimeoutError);
  return (err as Error).message;
}

describe("waitFor's timeout message (#185)", () => {
  it.each(FALSY)("prints %s as itself", async (printed, value) => {
    expect(await messageFor(value)).toMatch(new RegExp(`last value: ${escape(printed)}$`));
  });

  it("gives every falsy value its own message", async () => {
    const messages = await Promise.all(FALSY.map(([, v]) => messageFor(v)));
    expect(new Set(messages).size).toBe(FALSY.length);
  });
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
