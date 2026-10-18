import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { assertNoPublicSensitiveAccess, classifyIntegrationScope, collectPlanIndexes, compareCatalogs } from "../../scripts/phase7-integration-208.mjs";

test("integrated PostgreSQL evidence identifies only a temporary loopback cluster", () => {
  assert.equal(classifyIntegrationScope({
    host: "127.0.0.1",
    dataDirectory: "D:/validation/phase7/data",
    temporaryDirectory: "D:/validation/phase7",
    port: 54321,
  }), "disposable-loopback");
  assert.throws(() => classifyIntegrationScope({
    host: "0.0.0.0",
    dataDirectory: "D:/validation/phase7/data",
    temporaryDirectory: "D:/validation/phase7",
    port: 54321,
  }), /DATABASE_SCOPE_INVALID/u);
  assert.throws(() => classifyIntegrationScope({
    host: "127.0.0.1",
    dataDirectory: "D:/validation/shared/data",
    temporaryDirectory: "D:/validation/phase7",
    port: 54321,
  }), /DATABASE_SCOPE_INVALID/u);
});

test("integrated migration comparison rejects catalog drift", () => {
  assert.equal(compareCatalogs({ policies: [{ table: "consents" }] }, { policies: [{ table: "consents" }] }), true);
  assert.throws(() => compareCatalogs({ grants: ["select"] }, { grants: ["select", "update"] }), /CATALOG_DIFFERENCE/u);
});

test("restricted access assertion rejects schema or table privileges in either sensitive schema", () => {
  assert.equal(assertNoPublicSensitiveAccess([
    { grantee: "anon", schemaPrivileges: { interaction: { usage: false, create: false }, measurement: { usage: false, create: false } }, tablePrivileges: [] },
    { grantee: "authenticated", schemaPrivileges: { interaction: { usage: false, create: false }, measurement: { usage: false, create: false } }, tablePrivileges: [] },
    { grantee: "service_role", schemaPrivileges: { interaction: { usage: false, create: false }, measurement: { usage: false, create: false } }, tablePrivileges: [] },
  ]), true);
  assert.throws(() => assertNoPublicSensitiveAccess([
    { grantee: "anon", schemaPrivileges: { interaction: { usage: false, create: false }, measurement: { usage: true, create: false } }, tablePrivileges: [] },
  ]), /UNTRUSTED_DATABASE_GRANT/u);
  assert.throws(() => assertNoPublicSensitiveAccess([
    { grantee: "authenticated", schemaPrivileges: { interaction: { usage: false, create: true }, measurement: { usage: false, create: false } }, tablePrivileges: [] },
  ]), /UNTRUSTED_DATABASE_GRANT/u);
  assert.throws(() => assertNoPublicSensitiveAccess([
    { grantee: "service_role", schemaPrivileges: { interaction: { usage: false, create: false }, measurement: { usage: false, create: false } }, tablePrivileges: ["SELECT"] },
  ]), /UNTRUSTED_DATABASE_GRANT/u);
});

test("query plan index collector reports nested index usage", () => {
  assert.deepEqual(collectPlanIndexes({
    "Node Type": "Limit",
    Plans: [{ "Node Type": "Index Scan", "Index Name": "feedback_project_locale", Plans: [{ "Node Type": "Index Only Scan", "Index Name": "daily_aggregates_pkey" }] }],
  }), ["feedback_project_locale", "daily_aggregates_pkey"]);
});

test("Phase 7 aggregate migration inventory records canonical SQL checksums", () => {
  const runner = readFileSync(new URL("../../scripts/phase7-integration-208.mjs", import.meta.url), "utf8");
  assert.ok(/migrations:current\.map\(name=>\(\{name,sha256:migrationSha256\(/u.test(runner), "aggregate inventory must use canonical migration digests");
});
