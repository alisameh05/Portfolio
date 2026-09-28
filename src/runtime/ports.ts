/**
 * ports.ts — Phase 2 #26 provider-neutral runtime ports, Phase 3 #48 PostgreSQL runner.
 *
 * Small interfaces for Clock, stable-ID generation, Transaction Runner,
 * Logger, Request Context, Readiness, and lifecycle resources. This module
 * imports only the UUIDv7 library (already used by the shared domain for
 * stable identities) and plain TypeScript types — never Next.js, Supabase,
 * Kysely, Vercel, OpenAPI tooling, or generated transport code.
 *
 * Production uses the PostgreSQL transaction runner
 * (`src/shared/adapters/postgres/runtime.ts`): one `READ COMMITTED`
 * transaction per `run`, explicit opaque context, bounded lock/statement
 * timeouts, and safe redacted errors. The Phase 2 pass-through remains only
 * as the clearly named test fake `createPhase2TransactionFake`: it executes
 * one callback without claiming atomicity or rollback.
 */

import { uuidv7 } from "uuidv7";

// ── Clock ────────────────────────────────────────────────────────────────────

/** Provider-neutral clock returning RFC 3339 UTC instants. */
export interface Clock {
  /** Current instant as an RFC 3339 UTC string (e.g. `2026-09-20T12:00:00.000Z`). */
  now(): string;
}

/** System clock: time-dependent behavior stays deterministic in tests. */
export function createSystemClock(): Clock {
  return {
    now(): string {
      return new Date().toISOString();
    },
  };
}

// ── Stable-ID generation ─────────────────────────────────────────────────────

/**
 * Provider-neutral stable-ID generator with UUIDv7 semantics.
 *
 * The `kind` parameter preserves the shared-domain brandedidentity discipline
 * (`StableId<"Project">` cannot flow where `StableId<"Owner">` is expected);
 * the value itself is always a canonical lowercase UUIDv7 string.
 */
export interface StableIdGenerator {
  generate(kind: string): string;
}

/** System ID adapter returning UUIDv7 values behind stable-ID semantics. */
export function createSystemIdGenerator(): StableIdGenerator {
  return {
    generate(_kind: string): string {
      return uuidv7();
    },
  };
}

// ── Transaction Runner ───────────────────────────────────────────────────────

/**
 * Provider-neutral transaction runner port.
 *
 * Production (Phase 3 #48) supplies `createPostgresTransactionRunner`: the
 * callback receives one opaque `TransactionContext`, repository mutations
 * accept that context explicitly, and commit/rollback is atomic. Tests may
 * use `createPhase2TransactionFake`, which executes one callback without
 * claiming atomicity.
 */
export interface TransactionContext {
  /** Opaque marker only; provider handles are deliberately absent. */
  readonly kind: "transaction";
}

const ROLLBACK = Symbol("transaction-rollback");

export interface TransactionRollback<T> {
  readonly [ROLLBACK]: true;
  readonly value: T;
}

export function requestTransactionRollback<T>(value: T): TransactionRollback<T> {
  return Object.freeze({ [ROLLBACK]: true as const, value });
}

export function isTransactionRollback<T>(
  value: T | TransactionRollback<T>,
): value is TransactionRollback<T> {
  return typeof value === "object" && value !== null && ROLLBACK in value;
}

export interface TransactionRunner {
  run<T>(
    callback: (
      context: TransactionContext,
    ) => Promise<T | TransactionRollback<T>> | T | TransactionRollback<T>,
  ): Promise<T>;
}

// ── Logger ───────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Provider-neutral structured logger.
 *
 * Implementations emit one structured record per event with a stable event
 * name and level. Implementations must exclude request or response bodies,
 * credentials, cookies, raw identifiers, Feedback text, CV content, signed
 * URLs, connection strings, and other sensitive values (see redaction below).
 */
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set(
  [
    "body",
    "requestbody",
    "responsebody",
    "request",
    "response",
    "cookie",
    "cookies",
    "setcookie",
    "authorization",
    "password",
    "passwd",
    "token",
    "accesstoken",
    "refreshtoken",
    "secret",
    "secrets",
    "apikey",
    "feedback",
    "paragraph",
    "comment",
    "authorname",
    "cvcontent",
    "cv",
    "signedurl",
    "signedurls",
    "connectionstring",
    "databaseurl",
    "directurl",
    "sessionid",
    "functionalid",
    "visitorid",
    "rawidentifier",
    "rawidentifiers",
    "identity",
    "idempotencykey",
  ].map((name) => name.toLowerCase()),
);

const SENSITIVE_VALUE_PATTERN =
  /(postgres(?:ql)?:\/\/|signed\?|token=|tok_|hunter2|session=|eyJ[A-Za-z0-9_-]+\.|ghp_|sk-live|Bearer\s)/i;

/** Strip sensitive fields and redact secret-like values before emission. */
export function sanitizeLogFields(fields: LogFields = {}): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, "");
    if (SENSITIVE_FIELD_NAMES.has(normalized)) {
      continue;
    }
    if (typeof value === "string" && SENSITIVE_VALUE_PATTERN.test(value)) {
      clean[key] = "[redacted]";
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

export interface TestLogger extends Logger {
  readonly records: ReadonlyArray<{
    readonly level: LogLevel;
    readonly event: string;
    readonly fields: Record<string, unknown>;
  }>;
}

/** In-memory logger for deterministic tests; applies the same redaction. */
export function createTestLogger(): TestLogger {
  const mutable: Array<{
    readonly level: LogLevel;
    readonly event: string;
    readonly fields: Record<string, unknown>;
  }> = [];
  const emit =
    (level: LogLevel) =>
    (event: string, fields: LogFields = {}): void => {
      mutable.push({ level, event, fields: sanitizeLogFields(fields) });
    };
  return {
    get records() {
      return mutable;
    },
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}

// ── Request Context and correlation ──────────────────────────────────────────

/**
 * Provider-neutral request context.
 *
 * Every request receives a server-generated correlation identifier. An
 * untrusted inbound identifier never becomes the canonical identifier.
 */
export interface RequestContext {
  readonly traceId: string;
}

/**
 * Create a request context with a fresh server-generated trace identifier.
 *
 * The optional `inbound` value is accepted only so adapters can prove they
 * ignore it: it is never returned, logged as canonical, or echoed.
 */
export function createCorrelation(inbound?: string | null): RequestContext {
  void inbound;
  return { traceId: uuidv7() };
}

// ── Readiness and lifecycle resources ────────────────────────────────────────

/** Lifecycle states owned by the runtime coordinator (see #27 for behavior). */
export type LifecycleState = "starting" | "ready" | "draining" | "failed";

/** Provider-neutral readiness probe over the lifecycle state. */
export interface Readiness {
  getState(): LifecycleState;
  isReady(): boolean;
}

/** A closable runtime resource registered with the lifecycle coordinator. */
export interface LifecycleResource {
  readonly name: string;
  close(): Promise<void>;
}

/** A bounded dependency check contributing only a boolean readiness result. */
export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<boolean>;
}
