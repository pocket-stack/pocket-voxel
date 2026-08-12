/**
 * Both upstreams int()-convert per-map trainer-header keys. Dense 1..n
 * numeric-string keys therefore become arrays; sparse and zero-based maps
 * remain objects. This module is intentionally browser-safe because the text
 * extraction stage needs it.
 */
export function numericKeyed(value: Record<string, unknown>): unknown {
  const keys = Object.keys(value);
  if (keys.length === 0) return value;
  if (!keys.every((k) => /^[1-9][0-9]*$/.test(k))) return value;
  const ints = keys.map(Number).sort((a, b) => a - b);
  for (let i = 0; i < ints.length; i++) {
    if (ints[i] !== i + 1) return value;
  }
  return ints.map((k) => value[String(k)]);
}
