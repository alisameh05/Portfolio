/**
 * runtime-ports.test.ts — Phase 2 #26
 *
 * Seams under test (pre-agreed):
 * - Provider-neutral runtime ports via direct import (no framework types).
 * - System clock / ID / transaction-fake behavior via observable return values.
 * - Structured logger via captured records (no bodies, secrets, or identifiers).
 * - Server-generated correlation via returned trace identifiers.
 *
 * Acceptance (issue #26):
 * - Provider-neutral interfaces exist for Clock, stable-ID generation,
 *   Transaction Runner, Logger, Request Context, Readiness, and lifecycle
 *   resources without exposing framework or provider types.
 * - The system clock returns RFC 3339 UTC instants, the system ID adapter
 *   produces UUIDv7 values behind stable-ID semantics, and the explicitly
 *   named Phase 2 transaction fake executes one callback without claiming
 *   atomicity or rollback.
 * - Structured logging uses stable event names and levels and excludes
 *   request or response bodies, credentials, cookies, raw identifiers,
 *   Feedback, CV content, signed URLs, connection strings, and sensitive values.
 * - Every request receives a server-generated correlation identifier; an
 *   inbound identifier never becomes the canonical identifier.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createSystemClock,
  createSystemIdGenerator,
  createTestLogger,
  createCorrelation,
  type RequestContext,
} from "../../src/runtime/ports.js";
import { createPhase2TransactionFake } from "../../src/runtime/fakes/transaction.js";

const ROOT = process.cwd();
const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("runtime ports (#26)", () => {
  it("exposes provider-neutral ports without framework or provider types", () => {
    const content = readFileSync(join(ROOT, "src/runtime/ports.ts"), "utf8");
    expect(content).not.toMatch(/from\s+["']next\//);
    expect(content).not.toMatch(/from\s+["']@supabase\//);
    expect(content).not.toMatch(/from\s+["']kysely["']/);
    expect(content).not.toMatch(/from\s+["']zod["']/);
    expect(content).not.toMatch(/from\s+["']valibot["']/);
    expect(content).not.toMatch(/NextRequest|NextResponse/);
    for (const name of [
      "Clock",
      "StableIdGenerator",
      "TransactionRunner",
      "Logger",
      "RequestContext",
    ]) {
      expect(content).toContain(name);
    }
  });

  it("system clock returns RFC 3339 UTC instants", () => {
    const clock = createSystemClock();
    const instant = clock.now();
    expect(typeof instant).toBe("string");
    // RFC 3339 UTC: ISO 8601 with trailing Z and millisecond precision.
    expect(instant).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(instant).toISOString()).toBe(instant);
  });

  it("system ID adapter produces UUIDv7 values behind stable-ID semantics", () => {
    const ids = createSystemIdGenerator();
    const first = ids.generate("Project");
    const second = ids.generate("Project");
    expect(first).toMatch(UUID_V7_RE);
    expect(second).toMatch(UUID_V7_RE);
    expect(first).not.toBe(second);
  });

  it("Phase 2 transaction fake executes one callback without claiming atomicity", async () => {
    const tx = createPhase2TransactionFake();
    let calls = 0;
    const result = await tx.run(async () => {
      calls += 1;
      return "ok-value";
    });
    expect(result).toBe("ok-value");
    expect(calls).toBe(1);
    const content = readFileSync(join(ROOT, "src/runtime/fakes/transaction.ts"), "utf8");
    expect(content).toMatch(/Phase2/i);
    expect(content).toMatch(/fake/i);
    // The fake must disclaim atomicity/rollback rather than claim it.
    expect(content).toMatch(/without claiming|no atomic|without atomic/i);
    expect(content).toMatch(/no rollback/i);
  });

  it("structured logging uses stable event names and redacts sensitive values", () => {
    const logger = createTestLogger();
    logger.info("request.completed", {
      traceId: "trace-1",
      status: 200,
      body: "SHOULD-NEVER-APPEAR",
      cookie: "session=abc",
      password: "hunter2",
      feedback: "visitor wrote this",
      cvContent: "education history",
      signedUrl: "https://storage.example/signed?token=abc",
      connectionString: "postgres://user:pass@host/db",
      token: "tok_123",
    });
    expect(logger.records).toHaveLength(1);
    const record = logger.records[0] as {
      level: string;
      event: string;
      fields: Record<string, unknown>;
    };
    expect(record.level).toBe("info");
    expect(record.event).toBe("request.completed");
    const serialized = JSON.stringify(record);
    for (const secret of [
      "SHOULD-NEVER-APPEAR",
      "hunter2",
      "session=abc",
      "visitor wrote this",
      "education history",
      "signed?token=abc",
      "postgres://user",
      "tok_123",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // Safe diagnostics survive redaction.
    expect(record.fields["traceId"]).toBe("trace-1");
    expect(record.fields["status"]).toBe(200);
  });

  it("generates server-side correlation and never adopts an inbound identifier", () => {
    const first = createCorrelation(undefined);
    const second = createCorrelation("inbound-attacker-value");
    expect(first.traceId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(second.traceId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(second.traceId).not.toBe("inbound-attacker-value");
    expect(first.traceId).not.toBe(second.traceId);
    const context: RequestContext = second;
    expect(context.traceId).toBe(second.traceId);
  });
});
