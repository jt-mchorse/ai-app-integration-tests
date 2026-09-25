// Rendering a comparison that has already been decided (#125).
//
// `expectSemanticallySimilar` decides at full float precision:
//
//     if (similarity < threshold) throw new SemanticMismatchError(...)
//
// and then explained the decision at fixed precision — and at *two different*
// fixed precisions:
//
//     `semantic similarity ${similarity.toFixed(3)} below threshold ${threshold.toFixed(2)}`
//
// A mismatch is worse than a collision. At `similarity = 0.7449` against a
// `threshold` of `0.745`, that renders:
//
//     semantic similarity 0.745 below threshold 0.74
//
// The threshold's two places truncate `0.745` to `0.74`, which is *below* the
// similarity as rendered. The message says one number is below another and
// prints the larger one first. At `0.74999` against `0.75` it renders
// `0.750 below threshold 0.75`, the milder form where the two read as equal.
//
// This file's sibling header claims the helper gives "a clear failure message
// when it isn't". A near-threshold similarity is the one case where that claim
// mattered most and was false — a developer reading `0.745 below threshold 0.74`
// goes to debug the assertion helper rather than the response.
//
// **No test could have caught it.** The gate is right in every colliding case,
// so nothing asserting on pass/fail can fire. The only thing wrong was that the
// sentence disagreed with itself.
//
// Duplicated from the same fix in `prompt-regression-suite` (D-012),
// `llm-eval-harness` (D-026) and `rag-production-kit`, rather than shared: four
// separate distributions with no dependency between them, and inventing one so a
// twelve-line formatter could be imported would be the worse trade. Recorded in
// D-013 so it does not read later as accidental divergence.

// Widening ceiling. A double round-trips in at most 17 significant digits, so 17
// decimal places separates any two distinct doubles at the magnitudes a Jaccard
// similarity and its threshold occupy — both in [0, 1]. A ceiling rather than a
// guarantee: two subnormal-scale values render identically at *any* fixed number
// of places, which is what the exponential fallback below is for.
const MAX_PLACES = 17;

/**
 * Render two numbers so an ordering stated between them stays readable.
 *
 * Returns `[renderedValue, renderedOther]`, **always at the same width**.
 *
 * `places` is the *starting* width. It is a parameter, and required, because
 * this helper must never narrow a published number: the similarity has always
 * been rendered at three places, and dropping it to two to match the threshold
 * would trade one wrong message for a less precise one. `llm-eval-harness`
 * shipped exactly that regression (hardcoding a narrower default across call
 * sites that disagreed) and only that repo's published-values lock caught it.
 *
 * The rule is on the rendered strings rather than on a width, because a wider
 * fixed width relocates the collision instead of removing it: `toFixed(6)` on
 * both sides still collides at `0.7499999995`, and a rule expressed as a
 * hand-picked number of places has no way to say what it is for.
 *
 * Equal inputs return the narrow rendering unwidened — there is nothing to
 * distinguish, and widening would imply a difference that is not there. The
 * caller only reaches its message on a strict `<`, so it does not depend on
 * that, but the function is total and says what it does.
 */
export function renderComparison(
  value: number,
  other: number,
  places: number,
): [string, string] {
  if (value === other) {
    return [value.toFixed(places), other.toFixed(places)];
  }
  for (let width = places; width <= MAX_PLACES; width++) {
    const rendered: [string, string] = [value.toFixed(width), other.toFixed(width)];
    if (rendered[0] !== rendered[1]) return rendered;
  }
  // Two distinct doubles too small for any fixed-point rendering to separate.
  // `toExponential` keeps full significand, so it always distinguishes them.
  return [value.toExponential(), other.toExponential()];
}
