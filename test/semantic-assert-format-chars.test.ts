// tokenize deletes invisible format characters instead of splitting on them (#199).
//
// The punctuation class [^\p{L}\p{M}\p{N}\s] also caught \p{Cf}, so a soft
// hyphen, ZWNJ, ZWJ, word joiner or bidi mark inside a word became a space.
// Measured on `main`, each pair renders identically:
//   "The re<SHY>fund win<SHY>dow is 30 days" vs "The refund window is 30 days" -> 0.250
//   "क्<ZWJ>षमा" vs "क्षमा" -> 0.000
// Inputs are built from code points: the characters do not survive as literals.
import { describe, expect, it } from "vitest";

import { expectSemanticallySimilar, tokenize } from "../src/support/semantic-assert";

const ch = (cp: number): string => String.fromCodePoint(cp);
const SHY = ch(0xad);
const ZWSP = ch(0x200b);
const ZWNJ = ch(0x200c);
const ZWJ = ch(0x200d);
const RLM = ch(0x200f);
const WJ = ch(0x2060);

const PAIRS: Array<[string, string, string]> = [
  ["soft hyphen", `The re${SHY}fund win${SHY}dow is 30 days`, "The refund window is 30 days"],
  ["word joiner", `The refund${WJ}s are processed`, "The refunds are processed"],
  ["ZWNJ in a Persian word", `می${ZWNJ}خواهم کتاب`, "میخواهم کتاب"],
  ["ZWJ in a Devanagari conjunct", `क्${ZWJ}षमा`, "क्षमा"],
  ["RLM inside a Hebrew word", `שלו${RLM}ם עולם`, "שלום עולם"],
];

describe("tokenize and format characters (#199)", () => {
  it.each(PAIRS)("%s: the word stays one token", (_name, withFormat, plain) => {
    expect(tokenize(withFormat)).toEqual(tokenize(plain));
  });

  it.each(PAIRS)("%s: the assertion passes at 1.0", (_name, withFormat, plain) => {
    expect(expectSemanticallySimilar(withFormat, plain)).toBe(1);
  });

  it("a format character is deleted before NFC, so it cannot block composition", () => {
    expect(tokenize(`cafe${ZWJ}́`)).toEqual(tokenize("café"));
  });

  it("a zero width space still separates words (control: Thai has no spaces)", () => {
    expect(tokenize(`สวัสดี${ZWSP}ครับ`)).toEqual(["สวัสดี", "ครับ"]);
    expect(tokenize(`re${ZWSP}fund`)).toEqual(["re", "fund"]);
  });

  it("punctuation is still a separator (control)", () => {
    expect(tokenize("refund-window, 30/days")).toEqual(["refund", "window", "30", "days"]);
  });
});
