import { createHash, timingSafeEqual } from "node:crypto";
import type { DueWorkRunCommand, DueWorkRunResult } from "./phase7-due-work.js";
import { PHASE7_DUE_WORK_SCHEDULES } from "./phase7-due-work.js";
import {
  createDueWorkStopCheck,
  DEFAULT_PROTECTED_DUE_WORK_BUDGET,
  isValidPhase8DueWorkBudget,
  type DueWorkRuntimeObservationPort,
  type Phase8DueWorkBudget,
} from "./phase8-due-work-control.js";
import { safeDueWorkTotals } from "./phase8-due-work-summary.js";
import type { Rejection, Result } from "../shared/domain/index.js";

const MAX_HEADER_COUNT = 32;
const MAX_HEADER_BYTES = 8_192;
const MAX_AUTHORIZATION_BYTES = 512;
const MAX_CONTENT_LENGTH = 16_384;
const DEFAULT_PATH = "/internal/operations/phase7-due-work";

/** Provider mapping only. Phase 9 registers the handler and Phase 10 installs schedules/secrets. */
export const PHASE8_PROTECTED_DUE_WORK_HANDOFF = Object.freeze({
  provider: "Vercel Cron",
  method: "GET",
  path: DEFAULT_PATH,
  authorizationHeader: "Authorization: Bearer <configured secret>",
  providerSecretName: "CRON_SECRET",
  applicationSecretName: "CRON_TRIGGER_SECRET",
  secretMapping: "copy the same secret value to the application setting; Vercel does not infer this alias",
  userAgentIsAuthority: false,
  scheduleHeaderIsAuthority: false,
  routeRegistrationPhase: 9,
  scheduleInstallationPhase: 10,
  installed: false,
  schedules: Object.freeze(PHASE7_DUE_WORK_SCHEDULES.map((schedule) => Object.freeze({
    ...schedule,
    method: "GET",
    path: DEFAULT_PATH,
    routeRegistered: false,
    scheduleInstalled: false,
    registrationOwner: "Phase 9",
    installationOwner: "Phase 10",
  }))),
});

export interface ProtectedDueWorkTriggerDependencies {
  /** Internal setting; never read from the request or a URL. */
  readonly cronTriggerSecret?: string;
  /** Host-composed identity; request data never selects a worker or Portfolio. */
  readonly workerId: string;
  readonly runDueWork: (command: DueWorkRunCommand) => Promise<Result<DueWorkRunResult, Rejection>>;
  readonly observations: DueWorkRuntimeObservationPort;
  readonly budget?: Phase8DueWorkBudget;
  readonly expectedPath?: string;
  readonly isStopping?: () => boolean;
}

function response(status: number, body: Readonly<Record<string, unknown>>, extraHeaders: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

function equalSecret(candidate: string, expected: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function validConfiguredSecret(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/u.test(value);
}

function boundedHeaders(headers: Headers): "ok" | "too-large" {
  let count = 0;
  let bytes = 0;
  headers.forEach((value, name) => {
    count += 1;
    bytes += name.length + value.length;
  });
  return count > MAX_HEADER_COUNT || bytes > MAX_HEADER_BYTES ? "too-large" : "ok";
}

function validWorkerId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

/** Internal Web Request adapter; it is deliberately not a Next.js Route Handler. */
export function createProtectedDueWorkTrigger(deps: ProtectedDueWorkTriggerDependencies) {
  const budget = deps.budget ?? DEFAULT_PROTECTED_DUE_WORK_BUDGET;
  const expectedPath = deps.expectedPath ?? DEFAULT_PATH;

  return Object.freeze({
    async handle(request: Request): Promise<Response> {
      if (request.method !== "GET") return response(405, { ok: false, code: "method_not_allowed" }, { allow: "GET" });
      if (boundedHeaders(request.headers) === "too-large") return response(413, { ok: false, code: "request_too_large" });

      let url: URL;
      try { url = new URL(request.url); }
      catch { return response(400, { ok: false, code: "invalid_request" }); }
      if (url.pathname !== expectedPath || url.search !== "" || url.username !== "" || url.password !== "") {
        return response(400, { ok: false, code: "invalid_request" });
      }
      const rawLength = request.headers.get("content-length");
      if (rawLength !== null && !/^(?:0|[1-9][0-9]{0,8})$/u.test(rawLength)) {
        return response(400, { ok: false, code: "invalid_request" });
      }
      if (rawLength !== null && Number(rawLength) > MAX_CONTENT_LENGTH) {
        return response(413, { ok: false, code: "request_too_large" });
      }
      if ((rawLength !== null && Number(rawLength) > 0) || request.body !== null) {
        return response(400, { ok: false, code: "invalid_request" });
      }
      if (request.headers.has("cookie") || request.headers.has("cookie2")) {
        return response(401, { ok: false, code: "unauthorized" });
      }

      if (!validConfiguredSecret(deps.cronTriggerSecret) || !validWorkerId(deps.workerId) ||
          !isValidPhase8DueWorkBudget(budget) || typeof deps.isStopping !== "undefined" && typeof deps.isStopping !== "function") {
        return response(503, { ok: false, code: "trigger_unavailable" });
      }
      const authorization = request.headers.get("authorization") ?? "";
      if (authorization.length > MAX_AUTHORIZATION_BYTES) return response(413, { ok: false, code: "request_too_large" });
      const match = /^Bearer ([\x21-\x7e]{1,256})$/u.exec(authorization);
      const candidate = match?.[1] ?? "";
      if (candidate.length === 0 || !equalSecret(candidate, deps.cronTriggerSecret)) {
        return response(401, { ok: false, code: "unauthorized" });
      }

      try {
        const shouldStop = createDueWorkStopCheck({ budget, observations: deps.observations,
          isSignalled: () => request.signal.aborted || deps.isStopping?.() === true });
        // Evaluate host observations before dispatch so dependency failures use
        // the fixed response and cannot cross the worker boundary.
        shouldStop();
        const result = await deps.runDueWork({ workerId: deps.workerId,
          maxClaimsPerPhase: budget.maxClaimsPerPhase,
          maxWorkBatchSize: budget.maxWorkBatchSize,
          maxCatchUpPeriods: budget.maxCatchUpPeriods,
          maxOwnerExportClaims: budget.maxOwnerExportClaims,
          shouldStop,
        });
        if (!result.ok) return response(503, { ok: false, code: "due_work_unavailable" });
        const totals = safeDueWorkTotals(result.value);
        if (totals === undefined) return response(503, { ok: false, code: "due_work_unavailable" });
        return response(200, { ok: true, incomplete: totals["incomplete"], totals });
      } catch {
        return response(503, { ok: false, code: "due_work_unavailable" });
      }
    },
  });
}
