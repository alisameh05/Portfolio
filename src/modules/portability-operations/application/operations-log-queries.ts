export type OperationsLogFilter = Readonly<{ field: "category" | "outcome"; equals: string }>;

type OperationsLogAggregation =
  | Readonly<{ kind: "count"; where?: OperationsLogFilter }>
  | Readonly<{ kind: "sum"; field: "count"; where: OperationsLogFilter }>
  | Readonly<{ kind: "maximum"; field: "durationMs" }>
  | Readonly<{ kind: "latest"; field: "usedConnections" | "configuredLimit" }>
  | Readonly<{ kind: "group-count"; field: "route" | "statusClass" | "category"; values: readonly string[] }>
  | Readonly<{ kind: "storage-readiness"; field: "outcome" }>;

export type OperationsLogQueryDefinition = Readonly<{
  source: "operations.signal";
  signalField: "signal";
  signal: string;
  timestampField: "observedAt";
  windowSeconds: 900;
  maxCandidates: 1_000;
  maxResults: number;
  producerAvailability?: "not-installed";
  aggregation: OperationsLogAggregation;
}>;

const query = (signal: string, maxResults: number, aggregation: OperationsLogAggregation,
  producerAvailability?: "not-installed"): OperationsLogQueryDefinition => ({
  source: "operations.signal", signalField: "signal", signal, timestampField: "observedAt",
  windowSeconds: 900, maxCandidates: 1_000, maxResults,
  ...(producerAvailability === undefined ? {} : { producerAvailability }), aggregation,
});

export const OPERATIONS_LOG_QUERIES = Object.freeze({
  "http.request_count": query("http-request", 19, { kind: "group-count", field: "route",
    values: ["public-event", "public-current-cv", "public-feedback", "public-rating", "public-reaction", "owner-content-authoring",
      "owner-content-review", "owner-cv", "owner-analytics", "owner-export-request", "owner-export-status", "owner-export-download",
      "owner-media", "owner-moderation", "owner-project-status", "owner-project", "owner-publication", "owner-taxonomy", "owner-configuration"] }),
  "http.latency_ms": query("http-request", 1, { kind: "maximum", field: "durationMs" }),
  "http.status_class": query("http-request", 4, { kind: "group-count", field: "statusClass", values: ["2xx", "3xx", "4xx", "5xx"] }),
  "database.pool_used": query("database-pool", 1, { kind: "latest", field: "usedConnections" }),
  "database.pool_limit": query("database-pool", 1, { kind: "latest", field: "configuredLimit" }),
  "database.transaction_failures": query("database-failure", 1, { kind: "count", where: { field: "category", equals: "transaction" } }),
  "database.rls_denials": query("database-failure", 1, { kind: "count", where: { field: "category", equals: "authorization" } }),
  "database.pool_failures": query("database-failure", 1, { kind: "count", where: { field: "category", equals: "pool" } }),
  "leases.reclaim_count": query("lease-lifecycle", 1, { kind: "sum", field: "count", where: { field: "outcome", equals: "reclaimed" } }),
  "leases.stale_write_rejections": query("lease-lifecycle", 1, { kind: "sum", field: "count", where: { field: "outcome", equals: "stale-write" } }),
  "publication.safe_failures": query("publication-failure", 2, { kind: "group-count", field: "category", values: ["dependency", "transaction"] }),
  "event.accepted": query("event-intake", 1, { kind: "count", where: { field: "outcome", equals: "accepted" } }),
  "event.dropped": query("event-intake", 1, { kind: "count", where: { field: "outcome", equals: "dropped" } }, "not-installed"),
  "storage.failures": query("storage-operation", 1, { kind: "count", where: { field: "outcome", equals: "failed" } }),
  "storage.readiness": query("storage-operation", 1, { kind: "storage-readiness", field: "outcome" }),
  "export.integrity_failures": query("owner-export-integrity", 1, { kind: "count", where: { field: "outcome", equals: "failed" } }),
  "retention.failures": query("retention-work", 1, { kind: "count", where: { field: "outcome", equals: "failed" } }),
} as const satisfies Readonly<Record<string, OperationsLogQueryDefinition>>);

export type OperationsLogMetricId = keyof typeof OPERATIONS_LOG_QUERIES;
export type OperationsLogQueryResult =
  | Readonly<{ state: "measured"; value: number | string | Readonly<Record<string, number>> | Readonly<{ maximum: number; sampleCount: number }>; sampleCount: number }>
  | Readonly<{ state: "unknown"; reason: "producer-not-installed" | "not-collected" | "incomplete-sample" | "invalid-query" }>;

export function isOperationsLogQueryDefinition(metricId: string, value: unknown): value is OperationsLogQueryDefinition {
  return Object.hasOwn(OPERATIONS_LOG_QUERIES, metricId) && sameJson(value, OPERATIONS_LOG_QUERIES[metricId as OperationsLogMetricId]);
}

export function evaluateOperationsLogQuery(input: {
  readonly metricId: string;
  readonly definition: unknown;
  readonly serializedRecords: readonly string[];
  readonly observedAt: string;
  readonly sourceInstalled: boolean;
  readonly sourceComplete: boolean;
}): OperationsLogQueryResult {
  if (!isOperationsLogQueryDefinition(input.metricId, input.definition)) return { state: "unknown", reason: "invalid-query" };
  const definition = input.definition;
  if (!input.sourceInstalled) return { state: "unknown", reason: "producer-not-installed" };
  if (!input.sourceComplete) return { state: "unknown", reason: "not-collected" };
  if (definition.producerAvailability === "not-installed") return { state: "unknown", reason: "producer-not-installed" };
  if (!isUtcInstant(input.observedAt) || input.serializedRecords.length > definition.maxCandidates) {
    return { state: "unknown", reason: "incomplete-sample" };
  }

  const windowStart = Date.parse(input.observedAt) - definition.windowSeconds * 1_000;
  const matches: Readonly<Record<string, unknown>>[] = [];
  for (const serialized of input.serializedRecords) {
    let record: unknown;
    try { record = JSON.parse(serialized); } catch { return { state: "unknown", reason: "incomplete-sample" }; }
    if (!isRecord(record) || record["event"] !== definition.source || record["signal"] === undefined ||
        !isUtcInstant(record["observedAt"])) return { state: "unknown", reason: "incomplete-sample" };
    const timestamp = Date.parse(record[definition.timestampField] as string);
    if (timestamp > Date.parse(input.observedAt) || timestamp < windowStart || record[definition.signalField] !== definition.signal) continue;
    if (!isSafeRecordForSignal(record, definition.signal)) return { state: "unknown", reason: "incomplete-sample" };
    matches.push(record);
  }

  const aggregation = definition.aggregation;
  if (aggregation.kind === "count") {
    const count = matches.filter((record) => aggregation.where === undefined || record[aggregation.where.field] === aggregation.where.equals).length;
    return { state: "measured", value: count, sampleCount: matches.length };
  }
  if (aggregation.kind === "sum") {
    const selected = matches.filter((record) => record[aggregation.where.field] === aggregation.where.equals);
    const value = selected.reduce((total, record) => total + (record[aggregation.field] as number), 0);
    if (!Number.isSafeInteger(value) || value > 1_000_000_000) return { state: "unknown", reason: "incomplete-sample" };
    return { state: "measured", value, sampleCount: selected.length };
  }
  if (aggregation.kind === "maximum") {
    const values = matches.map((record) => record[aggregation.field] as number);
    if (values.length === 0) return { state: "unknown", reason: "not-collected" };
    return { state: "measured", value: { maximum: Math.max(...values), sampleCount: values.length }, sampleCount: values.length };
  }
  if (aggregation.kind === "latest") {
    const latest = matches.reduce<Readonly<Record<string, unknown>> | undefined>((selected, candidate) =>
      selected === undefined || Date.parse(candidate[definition.timestampField] as string) >=
        Date.parse(selected[definition.timestampField] as string) ? candidate : selected, undefined);
    return latest === undefined
      ? { state: "unknown", reason: "not-collected" }
      : { state: "measured", value: latest[aggregation.field] as number, sampleCount: 1 };
  }
  if (aggregation.kind === "group-count") {
    const values = Object.fromEntries(aggregation.values.map((value) => [value, 0]));
    for (const record of matches) {
      const key = record[aggregation.field];
      if (typeof key !== "string" || !(key in values)) return { state: "unknown", reason: "incomplete-sample" };
      values[key] = (values[key] ?? 0) + 1;
    }
    if (Object.keys(values).length > definition.maxResults) return { state: "unknown", reason: "invalid-query" };
    return { state: "measured", value: values, sampleCount: matches.length };
  }
  const failures = matches.filter((record) => record[aggregation.field] === "failed").length;
  const successes = matches.filter((record) => record[aggregation.field] === "succeeded").length;
  if (failures > 0) return { state: "measured", value: "degraded", sampleCount: matches.length };
  if (successes > 0) return { state: "measured", value: "ready", sampleCount: matches.length };
  return { state: "unknown", reason: "not-collected" };
}

function isSafeRecordForSignal(record: Readonly<Record<string, unknown>>, signal: string): boolean {
  const fields: Readonly<Record<string, readonly string[]>> = {
    "http-request": ["route", "statusClass", "durationMs"],
    "database-pool": ["usedConnections", "configuredLimit"],
    "database-failure": ["category"],
    "lease-lifecycle": ["outcome", "count", "ageSeconds"],
    "publication-failure": ["category"],
    "event-intake": ["outcome"],
    "storage-operation": ["operation", "outcome", "bytes"],
    "owner-export-integrity": ["outcome"],
    "retention-work": ["domain", "outcome", "processed"],
  };
  const allowed = new Set(["event", "observedAt", "signal", ...(fields[signal] ?? [])]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;
  const integer = (field: string, minimum = 0, maximum = 1_000_000_000) => Number.isSafeInteger(record[field]) &&
    (record[field] as number) >= minimum && (record[field] as number) <= maximum;
  switch (signal) {
    case "http-request": return ["public-event", "public-current-cv", "public-feedback", "public-rating", "public-reaction",
      "owner-content-authoring", "owner-content-review", "owner-cv", "owner-analytics", "owner-export-request", "owner-export-status",
      "owner-export-download", "owner-media", "owner-moderation", "owner-project-status", "owner-project", "owner-publication",
      "owner-taxonomy", "owner-configuration"].includes(String(record["route"])) &&
      ["2xx", "3xx", "4xx", "5xx"].includes(String(record["statusClass"])) && integer("durationMs", 0, 86_400_000);
    case "database-pool": return integer("usedConnections", 0, 1_000) && integer("configuredLimit", 1, 1_000);
    case "database-failure": return ["transaction", "authorization", "pool"].includes(String(record["category"]));
    case "lease-lifecycle": return ["reclaimed", "stale-write"].includes(String(record["outcome"])) && integer("count", 1, 1_000_000) &&
      (record["ageSeconds"] === undefined || typeof record["ageSeconds"] === "number" && Number.isFinite(record["ageSeconds"]) &&
        record["ageSeconds"] >= 0 && record["ageSeconds"] <= 31_536_000);
    case "publication-failure": return ["dependency", "transaction"].includes(String(record["category"]));
    case "event-intake": return ["accepted", "dropped", "rejected", "unavailable", "indeterminate"].includes(String(record["outcome"]));
    case "storage-operation": return ["read", "write", "delete"].includes(String(record["operation"])) &&
      ["succeeded", "failed"].includes(String(record["outcome"])) &&
      (record["bytes"] === undefined || integer("bytes", 0, 1_000_000_000));
    case "owner-export-integrity": return ["verified", "failed"].includes(String(record["outcome"]));
    case "retention-work": return ["measurement", "feedback"].includes(String(record["domain"])) &&
      ["completed", "incomplete", "failed"].includes(String(record["outcome"])) && integer("processed", 0, 1_000_000);
    default: return false;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(leftRecord[key], rightRecord[key]));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUtcInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
