/**
 * The first key `text` repeats inside one object, decoded, or `null` (#216, #270).
 *
 * `JSON.parse` keeps the LAST value of a duplicated key, so the parse is not the
 * whole text. A duplicate is the one way a valid JSON text holds a string its
 * parse drops. The committed-cassette rescan refuses one (#216): a credential
 * followed by `"x-api-key": "[REDACTED]"` parses clean while the credential is
 * committed. The recorder hashes a request body that holds one as its text
 * (#270), so `{"model":"a","model":"b"}` is not filed under `{"model":"b"}`.
 *
 * `text` must already have parsed, so this only tracks object nesting and string
 * tokens. Every object at any depth has its own key set, so one key in two
 * sibling objects is not a repeat. A key is compared decoded, so `"x-api-key"`
 * repeats `"x-api-key"`.
 */
export function duplicateKey(text: string): string | null {
  // One entry per open container: the keys seen so far for an object, `null`
  // for an array. `expectKey` is whether the next string in an object is a key.
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const keys = stack[stack.length - 1];
      if (keys && expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (keys.has(key)) return key;
        keys.add(key);
        expectKey = false;
      }
      i = j;
    } else if (ch === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (ch === "[") {
      stack.push(null);
      expectKey = false;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      expectKey = false;
    } else if (ch === ",") {
      expectKey = stack[stack.length - 1] != null;
    }
  }
  return null;
}
