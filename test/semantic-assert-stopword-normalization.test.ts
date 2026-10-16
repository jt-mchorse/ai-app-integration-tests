import { describe, expect, it } from "vitest";

import { expectSemanticallySimilar, tokenize } from "../src/support/semantic-assert.js";

// Caller stopwords are matched the way tokens are (#221).
//
// `tokenize` strips format characters (#199), NFC-normalizes (#165) and
// lowercases every token, then dropped one if the CALLER'S set had it as given.
// Measured on main:
//
//   tokenize("Claude answered", {"Claude"})  -> ["claude", "answered"]
//   tokenize("café café", {"café"})    -> ["café", "café"]
//   expectSemanticallySimilar("Claude refuses", "Claude", { stopwords: {"Claude"} })
//                                            -> SemanticMismatchError at 0.5
//
// Built from codepoints so the NFD / format-character spellings survive.
const NFD_CAFE = "café";
const NFC_CAFE = "café";
const SOFT_HYPHEN_REFUND = "re­fund";

describe("caller stopwords are normalized like tokens (#221)", () => {
  it.each([
    ["Claude", "Claude answered", ["answered"]],
    ["CLAUDE", "Claude answered", ["answered"]],
    ["claude", "CLAUDE answered", ["answered"]],
    [NFD_CAFE, `${NFC_CAFE} ${NFD_CAFE} open`, ["open"]],
    [NFC_CAFE, `${NFD_CAFE} open`, ["open"]],
    [SOFT_HYPHEN_REFUND, "refund window", ["window"]],
    ["Ünd", "ünd also", ["also"]],
  ])("stopword %j drops its word from %j", (stop, text, expected) => {
    expect(tokenize(text, new Set([stop]))).toEqual(expected);
  });

  it("a stopword set that empties both sides reaches the documented error, not a mismatch", () => {
    expect(() =>
      expectSemanticallySimilar("Claude refuses", "Claude", {
        stopwords: new Set(["Claude", "refuses"]),
      }),
    ).toThrow(/every token was dropped by the caller-supplied `stopwords` set/);
  });

  it("the default stopwords are unchanged (control)", () => {
    expect(tokenize("The refund is in the window")).toEqual(tokenize("refund window"));
  });

  it("an unrelated caller set drops nothing (control)", () => {
    expect(tokenize("Claude answered", new Set(["gemini"]))).toEqual(["claude", "answered"]);
  });

  it("a set mutated between calls is read as it now is", () => {
    const stops = new Set(["alpha"]);
    expect(tokenize("Alpha Beta", stops)).toEqual(["beta"]);
    stops.delete("alpha");
    stops.add("Beta");
    expect(tokenize("Alpha Beta", stops)).toEqual(["alpha"]);
  });
});
