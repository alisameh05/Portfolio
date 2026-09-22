import { createHash } from "node:crypto";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function normalize(value: CanonicalValue): CanonicalValue {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, CanonicalValue>>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalize(record[key] as CanonicalValue)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Canonical request numbers must be finite.");
  }
  return value;
}

/** Stable JSON encoding after transport validation; object keys sort, arrays do not. */
export function canonicalizeRequest(value: CanonicalValue): string {
  return JSON.stringify(normalize(value));
}

/** Lowercase SHA-256 over canonical UTF-8 bytes. */
export async function hashCanonicalRequest(value: CanonicalValue): Promise<string> {
  return createHash("sha256").update(canonicalizeRequest(value), "utf8").digest("hex");
}
