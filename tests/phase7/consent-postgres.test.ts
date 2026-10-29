import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { sql } from "kysely";
import { createPostgresRuntimeDatabase, resolvePostgresTransaction } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresConsentRepository } from "../../src/modules/measurement/adapters/postgres-consent.js";
import { createConsentApplicationService } from "../../src/modules/measurement/index.js";
import { AesGcmConsentEvidenceAdapter } from "../../src/modules/identity-access/adapters/consent-evidence.js";
import { createSystemIdGenerator, requestTransactionRollback } from "../../src/runtime/ports.js";
import { createStableId } from "../../src/shared/domain/index.js";
import { handlePostPublicEvent } from "../../src/runtime/http/public-event.js";
import { createPublicEventTestFake } from "../../src/runtime/fakes/public-event.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import { initializeDatabaseRuntime, getConsentApplicationService, resetRuntimeForTests } from "../../src/bootstrap/composition-root.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";

const url = process.env["PHASE7_CONSENT_DATABASE_URL"];
describe.runIf(Boolean(url))("real PostgreSQL consent boundary", () => {
  const portfolioId = createStableId("Portfolio"), foreignId = createStableId("Portfolio");
  const scope = { kind: "portfolio" as const, portfolioId };
  let now = "2026-10-14T12:00:00.000Z";
  const config = {
    functional: { active: { version: 1, secret: Buffer.alloc(32, 11).toString("base64url") }, previous: [] },
    measurement: { active: { version: 1, secret: Buffer.alloc(32, 22).toString("base64url") }, previous: [] },
  };
  const database = createPostgresRuntimeDatabase(url ?? "postgres://invalid");
  const repository = createPostgresConsentRepository();
  const service = createConsentApplicationService({ transactions: database.transactions, repository,
    crypto: new AesGcmConsentEvidenceAdapter(config, () => now), clock: { now: () => now }, ids: createSystemIdGenerator(),
    supportedNoticeVersions: ["2026-10"], ttlSeconds: 2_592_000 });
  const query = (token?: string) => ({ scope, correlationId: "test", noticeVersion: "2026-10", ...(token ? { token } : {}) });
  const grant = () => service.recordConsent({ scope, correlationId: "test", consent: "granted", noticeVersion: "2026-10", expectedRevision: 0 });
  const admin = new Client({ connectionString: process.env["PHASE7_CONSENT_ADMIN_URL"] });
  beforeAll(async () => { await admin.connect(); });
  afterAll(async () => { await admin.end(); await database.resource.close(); });
  it("persists explicit grants across fresh service/pool instances and withdrawal revokes unexpired evidence", async () => {
    const issued = await grant(); expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("grant");
    const verified = await service.verifyEvidence(query(issued.value.evidence)); expect(verified.ok).toBe(true);
    const second = createPostgresRuntimeDatabase(url!);
    try {
      const restarted = createConsentApplicationService({ transactions: second.transactions, repository,
        crypto: new AesGcmConsentEvidenceAdapter(config, () => now), clock: { now: () => now }, ids: createSystemIdGenerator(),
        supportedNoticeVersions: ["2026-10"], ttlSeconds: 2_592_000 });
      expect(await restarted.verifyEvidence(query(issued.value.evidence))).toEqual(verified);
      const withdrawn = await restarted.recordConsent({ scope, correlationId: "withdraw", consentId: issued.value.consentId,
        expectedRevision: 1, consent: "denied", noticeVersion: "2026-10" });
      expect(withdrawn).toMatchObject({ ok: true, value: { revision: 2, state: "denied" } });
      if (withdrawn.ok) expect(withdrawn.value.evidence).toBeUndefined();
      expect(await service.verifyEvidence(query(issued.value.evidence))).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    } finally { await second.resource.close(); }
  });
  it("denied/unknown/unsupported notices issue no identity; missing and forged evidence have no writes", async () => {
    for (const consent of ["denied", "unknown"] as const) {
      const result = await service.recordConsent({ scope, correlationId: "test", consent, expectedRevision: 0, noticeVersion: "2026-10" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("choice");
      expect(result.value.evidence).toBeUndefined();
      const rows = await admin.query("select subject from measurement.consents where consent_id=$1", [result.value.consentId]);
      expect(rows.rows[0].subject).toBeNull();
    }
    const before = await admin.query("select count(*)::int as count from measurement.consent_history");
    for (const token of [undefined, "granted", "forged_cookie"]) expect((await service.verifyEvidence(query(token))).ok).toBe(false);
    expect((await service.recordConsent({ scope, correlationId: "test", consent: "granted", expectedRevision: 0, noticeVersion: "unsupported" })).ok).toBe(false);
    expect((await admin.query("select count(*)::int as count from measurement.consent_history")).rows).toEqual(before.rows);
  });
  it("foreign Portfolio, unsupported notice and removed consent never authorize evidence", async () => {
    const issued = await grant(); if (!issued.ok) throw new Error("grant");
    expect((await service.verifyEvidence({ ...query(issued.value.evidence), scope: { kind: "portfolio", portfolioId: foreignId } })).ok).toBe(false);
    expect((await service.verifyEvidence({ ...query(issued.value.evidence), noticeVersion: "unsupported" })).ok).toBe(false);
    expect((await service.verifyEvidence({ ...query(issued.value.evidence), noticeVersion: "2026-09" })).ok).toBe(false);
    expect((await service.recordConsent({ scope: { kind: "portfolio", portfolioId: foreignId }, correlationId: "test", consent: "granted", consentId: issued.value.consentId, expectedRevision: 1, noticeVersion: "2026-10" })).ok).toBe(false);
    await admin.query("delete from measurement.consents where consent_id=$1", [issued.value.consentId]);
    expect((await service.verifyEvidence(query(issued.value.evidence))).ok).toBe(false);
  });
  it("crypto failure rolls back consent and minimal history atomically", async () => {
    const before = (await admin.query("select count(*)::int as count from measurement.consents")).rows;
    const broken = createConsentApplicationService({ transactions: database.transactions, repository, clock: { now: () => now },
      ids: createSystemIdGenerator(), supportedNoticeVersions: ["2026-10"], ttlSeconds: 3600,
      crypto: { async issue() { return { ok: false, error: { kind: "temporarily_unavailable", code: "CONSENT_CRYPTO_UNAVAILABLE" } }; }, async verify() { return { ok: false, error: { kind: "forbidden", code: "INVALID" } }; } } });
    expect((await broken.recordConsent({ scope, correlationId: "test", consent: "granted", expectedRevision: 0, noticeVersion: "2026-10" })).ok).toBe(false);
    expect((await admin.query("select count(*)::int as count from measurement.consents")).rows).toEqual(before);
    const orphans = await admin.query("select count(*)::int as count from measurement.consent_history h left join measurement.consents c using (portfolio_id, consent_id) where c.consent_id is null");
    expect(orphans.rows[0].count).toBe(0);
  });
  it("concurrent grant and withdrawal serialize one revision and reject the stale writer", async () => {
    const issued = await grant(); if (!issued.ok) throw new Error("grant");
    const base = { scope, correlationId: "race", expectedRevision: 1, consentId: issued.value.consentId, noticeVersion: "2026-10" };
    const results = await Promise.all([service.recordConsent({ ...base, consent: "granted" }), service.recordConsent({ ...base, consent: "denied" })]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toMatchObject([{ ok: false, error: { kind: "precondition_failed" } }]);
    const rows = await admin.query("select revision from measurement.consent_history where consent_id=$1 order by revision", [issued.value.consentId]);
    expect(rows.rows).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect((await service.verifyEvidence(query(issued.value.evidence))).ok).toBe(false);
  });
  it("transaction-participating verification holds withdrawal until intake commits", async () => {
    const issued = await grant(); if (!issued.ok) throw new Error("grant");
    let release!: () => void, locked!: () => void;
    const barrier = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { locked = r; });
    const intake = database.transactions.run(async tx => {
      const checked = await service.checkCurrentConsent(query(issued.value.evidence), tx);
      expect(checked.ok).toBe(true); locked(); await barrier; return checked;
    });
    await entered;
    const withdraw = service.recordConsent({ scope, correlationId: "withdraw-race", consentId: issued.value.consentId,
      expectedRevision: 1, consent: "denied", noticeVersion: "2026-10" });
    try {
      let blocked = false;
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const state = await admin.query("select 1 from pg_stat_activity where usename='consent_runtime' and wait_event_type='Lock'");
        if (state.rowCount) { blocked = true; break; }
      }
      expect(blocked).toBe(true);
    } finally { release(); }
    expect((await intake).ok).toBe(true); expect((await withdraw).ok).toBe(true);
    expect((await service.verifyEvidence(query(issued.value.evidence))).ok).toBe(false);
  });
  it("restricted roles enforce scope, append-only history and expiry-only worker deletion", async () => {
    const issued = await grant(); if (!issued.ok) throw new Error("grant");
    await database.transactions.run(async tx => {
      const db = resolvePostgresTransaction(tx);
      expect((await sql`select * from measurement.consents`.execute(db)).rows).toHaveLength(0);
      await sql`select set_config('shipwithali.portfolio_id', ${foreignId}, true)`.execute(db);
      expect((await sql`select * from measurement.consents where consent_id=${issued.value.consentId}::uuid`.execute(db)).rows).toHaveLength(0);
    });
    for (const role of ["anon", "authenticated"]) {
      const privileges = await admin.query("select has_schema_privilege($1,'measurement','USAGE') as usage, has_table_privilege($1,'measurement.consents','SELECT') as read", [role]);
      expect(privileges.rows[0]).toEqual({ usage: false, read: false });
    }
    const grants = await admin.query("select has_table_privilege('consent_runtime','measurement.consents','DELETE') as deletion, has_table_privilege('consent_runtime','measurement.consent_history','UPDATE') as overwrite");
    expect(grants.rows[0]).toEqual({ deletion: false, overwrite: false });
    const roles = await admin.query("select rolbypassrls, rolsuper from pg_roles where rolname in ('consent_runtime','shipwithali_application','shipwithali_worker')");
    expect(roles.rows.every(r => !r.rolbypassrls && !r.rolsuper)).toBe(true);
    await admin.query("begin; set local role shipwithali_worker");
    try {
      await admin.query("select set_config('shipwithali.portfolio_id',$1,true)", [portfolioId]);
      expect((await admin.query("delete from measurement.consents where consent_id=$1", [issued.value.consentId])).rowCount).toBe(0);
    } finally { await admin.query("rollback"); }
  });
  it("the real HTTP boundary requires current signed evidence and emits safe commands/receipts/logs", async () => {
    const issued = await grant(); if (!issued.ok) throw new Error("grant");
    const event = { action: "page-viewed", context: { occurredAt: now, locale: "en", pageRouteIdentity: createStableId("PublicRoute"), consentVersion: "2026-10" } };
    const request = (token?: string, noticeVersion = "2026-10") => new Request("https://example.com/api/v1/events", {
      method: "POST", headers: { "Idempotency-Key": "consent-189", ...(token ? { cookie: `sw_analytics_consent=${token}` } : {}) },
      body: JSON.stringify({ ...event, context: { ...event.context, consentVersion: noticeVersion } }) });
    const fake = createPublicEventTestFake({ type: "success" }), logger = createTestLogger();
    for (const token of [undefined, "granted", "forged"]) {
      expect((await handlePostPublicEvent(request(token), { service: fake, consent: service, scope, logger })).status).toBe(403);
    }
    expect((await handlePostPublicEvent(request(issued.value.evidence, "unsupported"), { service: fake, consent: service, scope, logger })).status).toBe(403);
    expect(fake.calls).toHaveLength(0);
    const response = await handlePostPublicEvent(request(issued.value.evidence), { service: fake, consent: service, scope, logger });
    expect(response.status).toBe(202); expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toHaveProperty("measurement.revision", 1);
    expect(fake.calls[0]?.actor).not.toHaveProperty("functionalId");
    const external = JSON.stringify({ body: await response.json(), logs: logger.records });
    const checked = await service.verifyEvidence(query(issued.value.evidence)); if (!checked.ok) throw new Error("verify");
    expect(external).not.toContain(checked.value.subject); expect(external).not.toContain(issued.value.evidence);
  });
  it("standard runtime assembly exposes the consent boundary and optional absence leaves core readiness available", async () => {
    const issued = await grant(); if (!issued.ok) throw new Error("grant");
    const runtime = createPostgresRuntimeDatabase(url!);
    const env = { NODE_ENV: "test", APP_BASE_URL: "https://example.com", DATABASE_URL: url! };
    const dependencies = { operations: createPostgresOperationsPersistence(runtime.database), resource: runtime.resource, identityReadiness: { name: "isolated-test-identity", async check() { return true; } }, readiness: runtime.readiness };
    const request = () => new Request("https://example.com/api/v1/events", { method: "POST", headers: {
      "Idempotency-Key": "assembled-consent", cookie: `sw_analytics_consent=${issued.value.evidence}` }, body: JSON.stringify({ action: "page-viewed",
        context: { occurredAt: now, locale: "en", pageRouteIdentity: createStableId("PublicRoute"), consentVersion: "2026-10" } }) });
    try {
      resetRuntimeForTests();
      await initializeDatabaseRuntime(env, "application", () => ({ ...dependencies, consent: service }));
      expect(getConsentApplicationService()).toBe(service);
      expect((await handlePostPublicEvent(request(), { scope, service: createPublicEventTestFake({ type: "success" }) })).status).toBe(202);
      resetRuntimeForTests();
      const state = await initializeDatabaseRuntime(env, "application", () => dependencies);
      expect(state.runtimeKind).toBe("application"); expect(getConsentApplicationService()).toBeUndefined();
      expect((await handlePostPublicEvent(request(), { scope, service: createPublicEventTestFake({ type: "success" }) })).status).toBe(403);
    } finally { resetRuntimeForTests(); await runtime.resource.close(); }
  });
  it("renewal preserves unexpired subjects but rotates them exactly at or after expiry", async () => {
    const initial = now;
    try {
      for (const offset of [-1, 0, 1]) {
        now = initial;
        const issued = await grant(); if (!issued.ok) throw new Error("grant");
        const old = await service.verifyEvidence(query(issued.value.evidence)); if (!old.ok) throw new Error("verify");
        now = new Date(Date.parse(issued.value.evidenceExpiresAt) + offset).toISOString();
        const renewed = await service.recordConsent({ scope, correlationId: "renew", consentId: issued.value.consentId,
          consent: "granted", noticeVersion: "2026-10", expectedRevision: 1 });
        if (!renewed.ok) throw new Error("renew");
        const current = await service.verifyEvidence(query(renewed.value.evidence)); if (!current.ok) throw new Error("verify");
        if (offset < 0) expect(current.value.subject).toBe(old.value.subject);
        else expect(current.value.subject).not.toBe(old.value.subject);
        expect((await service.verifyEvidence(query(issued.value.evidence))).ok).toBe(false);
      }
    } finally { now = initial; }
  });
  it("persisted current consent accepts supported previous-key evidence without changing subject", async () => {
    const issued = await grant(); if (!issued.ok) throw new Error("grant");
    const original = await service.verifyEvidence(query(issued.value.evidence)); if (!original.ok) throw new Error("verify");
    const rotated = { ...config, measurement: { active: { version: 2, secret: Buffer.alloc(32, 33).toString("base64url") }, previous: [config.measurement.active] } };
    const make = (crypto: AesGcmConsentEvidenceAdapter) => createConsentApplicationService({ transactions: database.transactions,
      repository, crypto, clock: { now: () => now }, ids: createSystemIdGenerator(), ttlSeconds: 2_592_000, supportedNoticeVersions: ["2026-10"] });
    expect(await make(new AesGcmConsentEvidenceAdapter(rotated, () => now)).verifyEvidence(query(issued.value.evidence))).toEqual(original);
    expect((await make(new AesGcmConsentEvidenceAdapter({ ...rotated, measurement: { ...rotated.measurement, previous: [] } }, () => now))
      .verifyEvidence(query(issued.value.evidence))).ok).toBe(false);
  });
});
