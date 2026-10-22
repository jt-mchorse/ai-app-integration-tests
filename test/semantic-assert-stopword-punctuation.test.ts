import { describe, expect, it } from "vitest";

import {
  expectSemanticallySimilar,
  jaccardSimilarity,
  tokenize,
} from "../src/support/semantic-assert.js";

// Caller stopwords go through the tokenizer's punctuation split too (#239).
//
// #221 normalized stopwords at the character level (format characters, NFC,
// lower-case) but not the punctuation-to-space split tokens also get, so a
// stopword carrying punctuation never equalled a token. Measured on main:
//
//   tokenize("don't stop", {"don't"})                      -> ["don", "t", "stop"]
//   French {"l'", "d'", "est"}: "L'heure d'ouverture est 9h"
//                               vs "Ouverture: 9h"         -> 0.400
//   the same set spelled {"l", "d", "est"}                 -> 0.667
//
// A stopword that splits to ONE token is kept as that token; one that splits
// to several is a phrase, dropped only as that adjacent run of tokens in order,
// so a standard English list ("don't", "isn't", "won't") keeps working and a
// lone "mail" or "t" survives.

const FR_ELIDED = new Set(["l'", "d'", "est"]);
const FR_BARE = new Set(["l", "d", "est"]);
const FR_A = "L'heure d'ouverture est 9h";
const FR_B = "Ouverture: 9h";

describe("a stopword with punctuation that splits to one token drops it (#239)", () => {
  it.each([
    ["l'", "L'heure est là", ["heure", "est", "là"]],
    ["d'", "Heure d'ouverture", ["heure", "ouverture"]],
    ["L'", "l'heure", ["heure"]],
    ["'tis", "'Tis the season", ["the", "season"]],
    ["Claude.", "Claude answered", ["answered"]],
  ])("stopword %j drops its token from %j", (stop, text, expected) => {
    expect(tokenize(text, new Set([stop]))).toEqual(expected);
  });

  it("the issue's French pair scores the same for both spellings of the set", () => {
    const elided = jaccardSimilarity(tokenize(FR_A, FR_ELIDED), tokenize(FR_B, FR_ELIDED));
    const bare = jaccardSimilarity(tokenize(FR_A, FR_BARE), tokenize(FR_B, FR_BARE));
    expect(elided).toBeCloseTo(2 / 3, 10);
    expect(elided).toBe(bare);
  });

  it("expectSemanticallySimilar passes with the elided set where it failed", () => {
    expect(
      expectSemanticallySimilar(FR_A, FR_B, { stopwords: FR_ELIDED, threshold: 0.6 }),
    ).toBeCloseTo(2 / 3, 10);
  });
});

describe("a stopword that splits to several tokens is dropped as a phrase (#239)", () => {
  it.each([
    ["don't", "Don't stop now", ["stop", "now"]],
    ["e-mail", "send an E-mail today", ["send", "an", "today"]],
    ["thank you", "thank you for waiting", ["for", "waiting"]],
    ["isn't", "it isn't here, isn't it", ["it", "here", "it"]],
    ["e-mail", "e-mail e mail", []],
  ])("stopword %j drops its run from %j", (stop, text, expected) => {
    expect(tokenize(text, new Set([stop]))).toEqual(expected);
  });

  it("a standard English list with contractions works in expectSemanticallySimilar", () => {
    const stops = new Set(["i", "don't", "isn't", "won't", "the", "is"]);
    expect(
      expectSemanticallySimilar("I don't think the refund window is open", "refund window open think", {
        stopwords: stops,
      }),
    ).toBe(1);
  });

  it("the longest phrase wins at a position", () => {
    expect(
      tokenize("thank you very much, see you", new Set(["thank you", "thank you very much"])),
    ).toEqual(["see", "you"]);
  });

  it("phrase and word stopwords combine", () => {
    expect(tokenize("don't send the e-mail", new Set(["don't", "the"]))).toEqual([
      "send",
      "e",
      "mail",
    ]);
  });
});

describe("controls", () => {
  it("a plain-word stopword still drops its word", () => {
    expect(tokenize("refund window open", new Set(["open"]))).toEqual(["refund", "window"]);
  });

  it("the default stopwords are unchanged", () => {
    expect(tokenize("Don't send the e-mail")).toEqual(["don", "t", "send", "e", "mail"]);
  });

  it.each([[""], ["'"], ["-"], ["..."]])(
    "a stopword with no tokens (%j) is accepted and drops nothing",
    (stop) => {
      expect(tokenize("it's a re-run", new Set([stop]))).toEqual(["it", "s", "a", "re", "run"]);
    },
  );

  it.each([
    ["e-mail", "check your mail", ["check", "your", "mail"]],
    ["don't", "t is a letter, don is a name", ["t", "is", "a", "letter", "don", "is", "a", "name"]],
    ["don't", "t don", ["t", "don"]],
    ["thank you", "thank them, then you", ["thank", "them", "then", "you"]],
  ])("phrase %j leaves its pieces alone outside the run: %j", (stop, text, expected) => {
    expect(tokenize(text, new Set([stop]))).toEqual(expected);
  });

  it("listing the pieces separately drops them anywhere", () => {
    expect(tokenize("don't stop", new Set(["don", "t"]))).toEqual(["stop"]);
  });
});
