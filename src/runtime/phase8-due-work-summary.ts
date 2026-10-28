import type { DueWorkRunResult } from "./phase7-due-work.js";

const MAX_SAFE_TOTAL = 10_000_000;

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_TOTAL
    ? value : undefined;
}

function safeAssemblyTotals(value: unknown): Readonly<Record<string, unknown>> | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const claimed = safeCount(row["claimed"]);
  const completed = safeCount(row["completed"]);
  const retried = safeCount(row["retried"]);
  const failed = safeCount(row["failed"]);
  const staleLeases = safeCount(row["staleLeases"]);
  if ([claimed, completed, retried, failed, staleLeases].some((count) => count === undefined)) return undefined;
  let cleanup: Readonly<Record<string, unknown>> | undefined;
  if (row["cleanup"] !== undefined) {
    if (row["cleanup"] === null || typeof row["cleanup"] !== "object" || Array.isArray(row["cleanup"])) return undefined;
    const source = row["cleanup"] as Record<string, unknown>;
    const scanned = safeCount(source["scanned"]);
    const deleted = safeCount(source["deleted"]);
    const pending = safeCount(source["pending"]);
    if (scanned === undefined || deleted === undefined || pending === undefined || typeof source["incomplete"] !== "boolean") return undefined;
    cleanup = { scanned, deleted, pending, incomplete: source["incomplete"] };
  }
  if (row["incompleteBacklog"] !== undefined && typeof row["incompleteBacklog"] !== "boolean") return undefined;
  return { claimed, completed, retried, failed, staleLeases,
    incompleteBacklog: row["incompleteBacklog"] === true, ...(cleanup === undefined ? {} : { cleanup }) };
}

/** Sanitized result shared by the HTTP adapter and CLI; IDs, provider details and exceptions are omitted. */
export function safeDueWorkTotals(value: DueWorkRunResult): Readonly<Record<string, unknown>> | undefined {
  const counts = {
    scheduled: safeCount(value.scheduled),
    deduplicated: safeCount(value.deduplicated),
    claimed: safeCount(value.claimed),
    completed: safeCount(value.completed),
    released: safeCount(value.released),
    failed: safeCount(value.failed),
    staleLeases: safeCount(value.staleLeases),
    processedCount: safeCount(value.processedCount),
  };
  if (Object.values(counts).some((count) => count === undefined) ||
      typeof value.incompleteBacklog !== "boolean" || typeof value.incompleteCoverage !== "boolean" ||
      typeof value.incompleteOwnerExports !== "boolean" || typeof value.incomplete !== "boolean") return undefined;
  const ownerExportAssembly = safeAssemblyTotals(value.ownerExportAssembly);
  if (ownerExportAssembly === undefined) return undefined;
  const incomplete = value.incomplete || value.incompleteBacklog || value.incompleteCoverage ||
    value.incompleteOwnerExports || ownerExportAssembly?.["incompleteBacklog"] === true ||
    (typeof ownerExportAssembly?.["cleanup"] === "object" && ownerExportAssembly["cleanup"] !== null &&
      (ownerExportAssembly["cleanup"] as Record<string, unknown>)["incomplete"] === true);
  return { ...counts, incompleteBacklog: value.incompleteBacklog,
    incompleteCoverage: value.incompleteCoverage, incompleteOwnerExports: value.incompleteOwnerExports,
    incomplete, ownerExportAssembly };
}
