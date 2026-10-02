import type { Rejection } from "@shared/domain";
import type { SafeResultEnvelope } from "../../portability-operations/index.js";

export type PortfolioCommandOutcome =
  | { readonly kind: "completed"; readonly aggregateId: string; readonly aggregateVersion: number }
  | { readonly kind: "rejected"; readonly rejectionKind: string; readonly code: string; readonly currentVersion?: number };

export function outcomeFromRejection(rejection: Rejection): PortfolioCommandOutcome {
  if (rejection.kind === "conflict" || rejection.kind === "precondition_failed") {
    return {
      kind: "rejected",
      rejectionKind: rejection.kind,
      code: rejection.code,
      ...(rejection.currentVersion === undefined ? {} : { currentVersion: rejection.currentVersion }),
    };
  }
  return { kind: "rejected", rejectionKind: rejection.kind, code: rejection.code };
}

export function readPortfolioCommandOutcome(result: SafeResultEnvelope): PortfolioCommandOutcome {
  const kind = result["kind"];
  if (kind === "completed" && typeof result["aggregateId"] === "string" &&
      typeof result["aggregateVersion"] === "number" && Number.isSafeInteger(result["aggregateVersion"]) &&
      result["aggregateVersion"] > 0) {
    return { kind, aggregateId: result["aggregateId"], aggregateVersion: result["aggregateVersion"] };
  }
  if (kind === "rejected" && typeof result["rejectionKind"] === "string" &&
      typeof result["code"] === "string" &&
      (result["currentVersion"] === undefined || Number.isSafeInteger(result["currentVersion"]))) {
    return {
      kind,
      rejectionKind: result["rejectionKind"],
      code: result["code"],
      ...(typeof result["currentVersion"] === "number" ? { currentVersion: result["currentVersion"] } : {}),
    };
  }
  throw new Error("Invalid stored portfolio configuration command result.");
}

export function rejectionFromPortfolioCommandOutcome(
  outcome: Extract<PortfolioCommandOutcome, { kind: "rejected" }>,
): Rejection {
  switch (outcome.rejectionKind) {
    case "validation": return { kind: "validation", code: outcome.code };
    case "unauthenticated": return { kind: "unauthenticated", code: outcome.code };
    case "forbidden": return { kind: "forbidden", code: outcome.code };
    case "not_found": return { kind: "not_found", code: outcome.code };
    case "conflict": return { kind: "conflict", code: outcome.code, ...(outcome.currentVersion === undefined ? {} : { currentVersion: outcome.currentVersion }) };
    case "precondition_failed": return { kind: "precondition_failed", code: outcome.code, ...(outcome.currentVersion === undefined ? {} : { currentVersion: outcome.currentVersion }) };
    case "rate_limited": return { kind: "rate_limited", code: outcome.code, retryAfterSeconds: 60 };
    case "temporarily_unavailable": return { kind: "temporarily_unavailable", code: outcome.code };
    default: throw new Error("Invalid stored portfolio configuration rejection.");
  }
}
