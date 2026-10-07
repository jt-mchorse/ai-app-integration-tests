// tokenize keeps combining marks and normalizes to NFC (#165).
//
// The class [^\p{L}\p{N}\s] turned every combining mark (\p{M}) into a space.
// Measured on `main`:
//   "किताब" (book) vs "कातिब" (scribe) -> both ["क","त","ब"], similarity 1.000
//   "café au lait" (NFC) vs "café au lait" (NFD) -> 0.500, fails at 0.6
// The first is a false pass of the vacuous kind #99/#109 closed elsewhere.
import { describe, expect, it } from "vitest";

import { expectSemanticallySimilar, jaccardSimilarity, tokenize } from "../src/support/semantic-assert";

describe("tokenize and combining marks (#165)", () => {
  it("different Devanagari words are different tokens", () => {
    expect(tokenize("किताब")).toEqual(["किताब"]);
    expect(jaccardSimilarity(tokenize("किताब"), tokenize("कातिब"))).toBe(0);
  });

  it("a word with a vowel sign is one token, not its consonants", () => {
    expect(tokenize("नमस्ते दुनिया")).toEqual(["नमस्ते", "दुनिया"]);
  });

  it("NFC and NFD spellings of one word are one token", () => {
    const nfc = "café au lait";
    const nfd = "café au lait";
    expect(tokenize(nfd)).toEqual(tokenize(nfc));
    expect(() => expectSemanticallySimilar(nfd, nfc)).not.toThrow();
  });

  it("different Devanagari sentences no longer pass the default threshold", () => {
    expect(() => expectSemanticallySimilar("किताब", "कातिब")).toThrow();
  });

  it("punctuation is still stripped and ASCII is unchanged (control)", () => {
    expect(tokenize("Hello, world! It's 5 o'clock.")).toEqual(["hello", "world", "s", "5", "o", "clock"]);
  });
});
