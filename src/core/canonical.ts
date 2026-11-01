import { createHash } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Canonical JSON is byte preserving for strings; callers supply resolved paths. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('non_finite_number');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError('not_json');
    if (ancestors.has(item)) throw new TypeError('cyclic_json');
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    ) {
      throw new TypeError('not_plain_json_object');
    }
    if (Object.getOwnPropertySymbols(item).length > 0) throw new TypeError('symbol_json_key');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        return `[${Array.from(item, (entry) => encode(entry)).join(',')}]`;
      }
      return `{${Object.keys(item)
        .sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          if (!('value' in descriptor)) throw new TypeError('accessor_json_property');
          return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
        })
        .join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return encode(value);
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function isCanonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.includes('\0') &&
    (value === '/' ||
      (!value.endsWith('/') &&
        value
          .slice(1)
          .split('/')
          .every((part) => part !== '' && part !== '.' && part !== '..')))
  );
}

export function requireCanonicalAbsolutePath(value: unknown): asserts value is string {
  if (!isCanonicalAbsolutePath(value)) throw new TypeError('canonical_absolute_path_required');
}
