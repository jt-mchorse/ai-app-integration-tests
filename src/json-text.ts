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

/**
 * `text` parsed with every member kept (#273): an object that repeats a key
 * reads as the list of its members, each a one-member object, in order.
 *
 * `JSON.parse` drops the earlier values of a repeated key, so a scan of its
 * parse never reads them decoded, and the raw text does not catch an escaped
 * one either: after `\n` the key reads `\nsk-…`, where `\bsk-` cannot match.
 * Each member stays an object so a value keeps its key beside it for the
 * `key=` patterns. An object without a repeat parses as `JSON.parse` would.
 *
 * `text` must already have parsed, so every token here is well formed.
 */
export function parseKeepingDuplicates(text: string): unknown {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const str = (): string => {
    let j = i + 1;
    while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    const s = JSON.parse(text.slice(i, j + 1)) as string;
    i = j + 1;
    return s;
  };
  const value = (): unknown => {
    ws();
    const ch = text[i];
    if (ch === '"') return str();
    if (ch === "[") {
      i++;
      const items: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return items;
      }
      for (;;) {
        items.push(value());
        ws();
        if (text[i++] === "]") return items;
      }
    }
    if (ch === "{") {
      i++;
      const members: Array<[string, unknown]> = [];
      ws();
      if (text[i] === "}") i++;
      else {
        for (;;) {
          ws();
          const key = str();
          ws();
          i++; // `:`
          members.push([key, value()]);
          ws();
          if (text[i++] === "}") break;
        }
      }
      const keys = new Set(members.map(([k]) => k));
      // `defineProperty`, not assignment: a `__proto__` key is a member here too.
      const object = (entries: Array<[string, unknown]>): Record<string, unknown> => {
        const o: Record<string, unknown> = {};
        for (const [k, v] of entries) {
          Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
        }
        return o;
      };
      return keys.size === members.length ? object(members) : members.map((m) => object([m]));
    }
    let j = i;
    while (j < text.length && !",]} \t\n\r".includes(text[j])) j++;
    const primitive: unknown = JSON.parse(text.slice(i, j));
    i = j;
    return primitive;
  };
  return value();
}
