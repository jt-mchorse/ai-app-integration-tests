// defaultClassify reads the `cause` chain and the SDKs' connection classes (#163).
//
// The Anthropic SDK wraps a network failure: the outer error is named "Error"
// with the message "Connection error." (or "Request timed out."), and
// "fetch failed" / ECONNREFUSED live only on `.cause`. The classifier read the
// outer error alone, so `withRetryBudget` made ONE call on a refused port and
// on a silent server where three were budgeted. The real-SDK arms are in
// example-app/test/retry-sdk-connection.test.ts; these pin the rule itself.
import { describe, expect, it } from "vitest";

import { defaultClassify } from "../src/support/retry-budget";

function chain(...errs: Error[]): Error {
  for (let i = 0; i < errs.length - 1; i++) (errs[i] as { cause?: unknown }).cause = errs[i + 1];
  return errs[0];
}

describe("defaultClassify — the cause chain (#163)", () => {
  it("a network error one level down is a flake (the SDK's shape)", () => {
    const err = chain(new Error("Connection error."), new TypeError("fetch failed"));
    expect(defaultClassify(err)).toBe("flake");
  });

  it("an errno two levels down, carried only as `code`, is a flake", () => {
    const sys = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    const err = chain(new Error("Connection error."), new TypeError("request failed"), sys);
    expect(defaultClassify(err)).toBe("flake");
  });

  it("a cyclic cause chain terminates and stays hard", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    expect(defaultClassify(a)).toBe("hard");
  });

  it("the walk is bounded: a network error 20 levels down is not reached", () => {
    const errs = Array.from({ length: 20 }, (_, i) => new Error(`wrap ${i}`));
    errs.push(new TypeError("fetch failed"));
    expect(defaultClassify(chain(...errs))).toBe("hard");
  });

  it("a 4xx is hard even when something below it was a network error", () => {
    const err = Object.assign(new Error("Bad Request"), { status: 400 });
    (err as { cause?: unknown }).cause = new TypeError("fetch failed");
    expect(defaultClassify(err)).toBe("hard");
  });

  it("a plain error with an unrelated cause stays hard (control)", () => {
    expect(defaultClassify(chain(new Error("boom"), new RangeError("bad index")))).toBe("hard");
  });
});

describe("defaultClassify — SDK connection classes (#163)", () => {
  class APIError extends Error {}
  class APIConnectionError extends APIError {}
  class APIConnectionTimeoutError extends APIConnectionError {}
  class BadRequestError extends APIError {}

  it("APIConnectionError and its timeout subclass are flakes, with no cause at all", () => {
    expect(defaultClassify(new APIConnectionError("Connection error."))).toBe("flake");
    expect(defaultClassify(new APIConnectionTimeoutError("Request timed out."))).toBe("flake");
  });

  it("a sibling API error class is not (control)", () => {
    expect(defaultClassify(new BadRequestError("invalid model"))).toBe("hard");
  });

  it("matching is on the class name, not on `name` (the SDK leaves `name` as 'Error')", () => {
    const err = new APIConnectionError("Connection error.");
    expect(err.name).toBe("Error");
    expect(defaultClassify(err)).toBe("flake");
  });
});
