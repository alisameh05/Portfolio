export type RecoveryTargetConfig = Readonly<{
  environment: string;
  targetIdentity: string;
  sourceIdentity: string;
  protectedIdentities: readonly string[];
  allowlistedTargetIdentities: readonly string[];
  objectTargetIdentity: string;
  sourceObjectIdentity: string;
  protectedObjectIdentities: readonly string[];
  allowlistedObjectIdentities: readonly string[];
}>;

export type RecoveryRehearsalInput = Readonly<{
  target: RecoveryTargetConfig;
  referenceAt: string;
  relationalRpoHours: number;
  mediaRpoHours: number;
  rtoTargetMilliseconds: number;
  /** Operator-measured time spent discovering the copy and obtaining access. */
  discoveryAccessMilliseconds: number;
  startedAt: string;
  /** Operator-measured pause time; included in the startedAt-to-verifiedAt wall interval. */
  manualPauseMilliseconds: number;
}>;

export type RecoveryRelationalCopy = Readonly<{ copyId: string; sourceWatermarkAt: string | null; encryptedBytes: number | null;
  schemaCount: number | null; relationCount: number | null; migrationCount: number | null }>;
export type RecoveryObjectCopy = Readonly<{ copyId: string; sourceWatermarkAt: string | null; encryptedBytes: number | null;
  objectCount: number | null; mediaBytes: number | null; exportBytes: number | null; objectIds: readonly string[] }>;
export type RecoveryCopies = Readonly<{ relational: RecoveryRelationalCopy; object: RecoveryObjectCopy | null }>;

export type RecoveryDomainFacts = Readonly<{
  ids: number | null;
  relationships: number | null;
  hashes: number | null;
  snapshotSha256: string | null;
  expectedSnapshotSha256: string | null;
  locales: boolean;
  lifecycle: boolean;
  routes: boolean;
  taxonomy: boolean;
  mediaAccessibility: boolean;
  cvHistory: boolean;
  moderationPrivacy: boolean;
  analyticsPrivacy: boolean;
  configuration: boolean;
}>;

export type RecoveryRehearsalStage =
  | "copy_selection" | "object_copy_selection" | "download_decrypt_validate" | "object_download_decrypt_validate"
  | "target_identity_verification" | "quarantine" | "relational_restore" | "object_restore" | "deletion_reconciliation" | "credential_and_grant_reconciliation"
  | "queue_and_effect_reconciliation" | "projection_rebuild" | "domain_verification"
  | "restricted_rls_and_readiness" | "timing_qualification" | "quarantine_release" | "owned_resource_cleanup";

export interface RecoveryRehearsalPort {
  now(): string;
  selectCopies(): Promise<RecoveryCopies>;
  /** The relational copy only is authenticated before restore. Object selection waits for IDs in that restored snapshot. */
  verifyKeysAndCopies(copies: RecoveryCopies): Promise<void>;
  verifyTarget(config: RecoveryTargetConfig): Promise<void>;
  enterQuarantine(): Promise<void>;
  restoreRelational(copies: RecoveryCopies): Promise<void>;
  selectObjectCopy(copies: RecoveryCopies): Promise<RecoveryObjectCopy>;
  verifyObjectKeysAndCopies(copies: RecoveryCopies, object: RecoveryObjectCopy): Promise<void>;
  restoreObjects(copies: RecoveryCopies, object: RecoveryObjectCopy): Promise<void>;
  reconcileCurrentDeletionLedger(): Promise<Readonly<{ revoked: number; acknowledgedDeleted: number }>>;
  resetCredentialsAndReconcileGrants(): Promise<void>;
  reconcileRecoveredEffects(): Promise<Readonly<{ suppressed: number; unresolved: number }>>;
  rebuildProjections(): Promise<void>;
  verifyDomainMeaning(): Promise<RecoveryDomainFacts>;
  verifyRestrictedRlsAndReadiness(): Promise<Readonly<{ allowCases: number; denyCases: number; ready: boolean }>>;
  releaseQuarantine(): Promise<void>;
  cleanupOwnedTargets(): Promise<Readonly<{ databases: number; objects: number; temporaryFiles: number; complete: boolean }>>;
  recordSafeIncident(code: string): Promise<void>;
}

export type RecoveryRehearsalReport = Readonly<{
  status: "complete" | "failed";
  releaseBlocker: boolean;
  accessReleased: boolean;
  referenceAt: string;
  relationalWatermarkAt: string | null;
  mediaWatermarkAt: string | null;
  relationalRpoHours: number | null;
  mediaRpoHours: number | null;
  relationalBytes: number | null;
  mediaBytes: number | null;
  exportBytes: number | null;
  objectCount: number | null;
  schemaCount: number | null;
  relationCount: number | null;
  migrationCount: number | null;
  domain: RecoveryDomainFacts | null;
  deletionLedger: Readonly<{ revoked: number; acknowledgedDeleted: number }> | null;
  effects: Readonly<{ suppressed: number; unresolved: number }> | null;
  rls: Readonly<{ allowCases: number; denyCases: number; ready: boolean }> | null;
  startedAt: string;
  verifiedAt: string | null;
  measuredRtoMilliseconds: number | null;
  manualPauseMilliseconds: number;
  discoveryAccessMilliseconds: number;
  stageMilliseconds: Readonly<Record<string, number>>;
  failureStage: RecoveryRehearsalStage | null;
  failureCode: string | null;
  incident: Readonly<{ code: string; recorded: boolean }> | null;
  cleanup: Readonly<{ databases: number; objects: number; temporaryFiles: number; complete: boolean }>;
}>;

export class RecoveryRehearsalError extends Error {
  constructor(readonly safeCode: string) { super(safeCode); }
}

function parseIdentity(value: string, credentialsRequired: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RecoveryRehearsalError("RECOVERY_TARGET_IDENTITY_INVALID"); }
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) || !url.hostname ||
      (credentialsRequired && (!url.username || !url.password)) ||
      (!credentialsRequired && (url.username || url.password)) ||
      !url.pathname.slice(1) || url.hash || [...url.searchParams.keys()].some(key => key !== "sslmode")) {
    throw new RecoveryRehearsalError("RECOVERY_TARGET_IDENTITY_INVALID");
  }
  return url;
}

function resourceIdentity(url: URL): string {
  return `postgresql://${url.hostname.toLowerCase()}:${url.port || "5432"}/${decodeURIComponent(url.pathname.slice(1))}`;
}

function parseObjectIdentity(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RecoveryRehearsalError("RECOVERY_OBJECT_TARGET_IDENTITY_INVALID"); }
  if (!(url.protocol === "file:" || url.protocol === "s3:" || url.protocol === "https:") ||
      (url.protocol !== "file:" && !url.hostname) || url.username || url.password || url.search || url.hash || !url.pathname ||
      (url.protocol === "file:" && url.hostname)) {
    throw new RecoveryRehearsalError("RECOVERY_OBJECT_TARGET_IDENTITY_INVALID");
  }
  return url;
}

function objectResourceIdentity(url: URL): string {
  let pathname = decodeURIComponent(url.pathname);
  if (url.protocol === "file:" && /^[\\/][a-z]:/iu.test(pathname)) pathname = pathname.toLowerCase();
  const normalizedPort = url.port && !((url.protocol === "https:" && url.port === "443")) ? `:${url.port}` : "";
  return `${url.protocol}//${url.hostname.toLowerCase()}${normalizedPort}${pathname}`;
}

function credentialParts(url: URL): readonly [string, string] {
  return [decodeURIComponent(url.username), decodeURIComponent(url.password)];
}

export function validateRecoveryTarget(config: RecoveryTargetConfig): void {
  if (config.environment === "production") throw new RecoveryRehearsalError("RECOVERY_PRODUCTION_TARGET_FORBIDDEN");
  if (!["local", "test", "staging"].includes(config.environment)) throw new RecoveryRehearsalError("RECOVERY_ENVIRONMENT_INVALID");
  const target = parseIdentity(config.targetIdentity, true);
  const source = parseIdentity(config.sourceIdentity, true);
  const targetResource = resourceIdentity(target);
  if (targetResource === resourceIdentity(source) || config.protectedIdentities.some(identity =>
    targetResource === resourceIdentity(parseIdentity(identity, false)))) {
    throw new RecoveryRehearsalError("RECOVERY_TARGET_PROTECTED");
  }
  const allowlisted = config.allowlistedTargetIdentities.some(identity => targetResource === resourceIdentity(parseIdentity(identity, false)));
  if (!allowlisted) throw new RecoveryRehearsalError("RECOVERY_TARGET_NOT_ALLOWLISTED");
  const objectTarget = parseObjectIdentity(config.objectTargetIdentity);
  const sourceObject = parseObjectIdentity(config.sourceObjectIdentity);
  const objectTargetResource = objectResourceIdentity(objectTarget);
  if (objectTargetResource === objectResourceIdentity(sourceObject) || config.protectedObjectIdentities.some(identity =>
    objectTargetResource === objectResourceIdentity(parseObjectIdentity(identity)))) {
    throw new RecoveryRehearsalError("RECOVERY_OBJECT_TARGET_PROTECTED");
  }
  const objectAllowlisted = config.allowlistedObjectIdentities.some(identity =>
    objectTargetResource === objectResourceIdentity(parseObjectIdentity(identity)));
  if (!objectAllowlisted) throw new RecoveryRehearsalError("RECOVERY_OBJECT_TARGET_NOT_ALLOWLISTED");
  const knownCredentials = [credentialParts(source), ...config.protectedIdentities.map(identity => parseIdentity(identity, false))
    .filter(identity => identity.username && identity.password).map(credentialParts)];
  if (knownCredentials.some(parts => parts.some(part => credentialParts(target).includes(part)))) {
    throw new RecoveryRehearsalError("RECOVERY_CREDENTIALS_NOT_SEPARATE");
  }
}

function hoursBetween(referenceAt: string, watermarkAt: string | null): number | null {
  if (watermarkAt === null) return null;
  const reference = Date.parse(referenceAt), watermark = Date.parse(watermarkAt);
  if (!Number.isFinite(reference) || !Number.isFinite(watermark) || watermark > reference) return null;
  return Math.floor((reference - watermark) / 3_600_000 * 1000) / 1000;
}

function domainComplete(value: RecoveryDomainFacts): boolean {
  return Number.isSafeInteger(value.ids) && Number.isSafeInteger(value.relationships) && Number.isSafeInteger(value.hashes) &&
    value.ids! >= 0 && value.relationships! >= 0 && value.hashes! >= 0 && /^[0-9a-f]{64}$/u.test(value.snapshotSha256 ?? "") &&
    value.snapshotSha256 === value.expectedSnapshotSha256 && value.locales && value.lifecycle && value.routes && value.taxonomy &&
    value.mediaAccessibility && value.cvHistory && value.moderationPrivacy && value.analyticsPrivacy && value.configuration;
}

function safeFailureCode(error: unknown, fallback: string): string {
  if (error instanceof RecoveryRehearsalError) return error.safeCode;
  if (typeof error === "object" && error !== null && "safeCode" in error &&
      typeof (error as { safeCode?: unknown }).safeCode === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/u.test((error as { safeCode: string }).safeCode)) {
    return (error as { safeCode: string }).safeCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(message) ? message : fallback;
}

function validateInput(input: RecoveryRehearsalInput): void {
  validateRecoveryTarget(input.target);
  const reference = Date.parse(input.referenceAt);
  const started = Date.parse(input.startedAt);
  if (!Number.isFinite(reference) || !Number.isFinite(started) || started < reference ||
      !Number.isSafeInteger(input.relationalRpoHours) || input.relationalRpoHours <= 0 ||
      !Number.isSafeInteger(input.mediaRpoHours) || input.mediaRpoHours <= 0 ||
      !Number.isSafeInteger(input.rtoTargetMilliseconds) || input.rtoTargetMilliseconds <= 0 ||
      !Number.isSafeInteger(input.discoveryAccessMilliseconds) || input.discoveryAccessMilliseconds < 0 ||
      !Number.isSafeInteger(input.manualPauseMilliseconds) || input.manualPauseMilliseconds < 0) {
    throw new RecoveryRehearsalError("RECOVERY_MEASUREMENT_CONFIG_INVALID");
  }
  if (input.discoveryAccessMilliseconds > started - reference) {
    throw new RecoveryRehearsalError("RECOVERY_MEASUREMENT_CONFIG_INVALID");
  }
}

export async function runRecoveryRehearsal(input: RecoveryRehearsalInput, port: RecoveryRehearsalPort): Promise<RecoveryRehearsalReport> {
  validateInput(input);
  const manualPauseMilliseconds = input.manualPauseMilliseconds;
  const discoveryAccessMilliseconds = input.discoveryAccessMilliseconds;
  let copies: RecoveryCopies | null = null;
  let deletionLedger: RecoveryRehearsalReport["deletionLedger"] = null;
  let effects: RecoveryRehearsalReport["effects"] = null;
  let domain: RecoveryDomainFacts | null = null;
  let rls: RecoveryRehearsalReport["rls"] = null;
  let failureCode: string | null = null;
  let verifiedAt: string | null = null;
  let measuredRtoMilliseconds: number | null = null;
  let accessReleased = false;
  let targetVerified = false;
  const stageMilliseconds: Record<string, number> = {};
  stageMilliseconds["discovery_access"] = discoveryAccessMilliseconds;
  stageMilliseconds["manual_pauses"] = manualPauseMilliseconds;
  let failureStage: RecoveryRehearsalStage | null = null;
  const measure = async <T>(stage: RecoveryRehearsalStage, action: () => Promise<T>): Promise<T> => {
    const started = Date.parse(port.now());
    try { return await action(); }
    catch (error) { failureStage = stage; throw error; }
    finally {
      const ended = Date.parse(port.now());
      if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
        stageMilliseconds[stage] = ended - started;
      }
    }
  };
  let cleanup: RecoveryRehearsalReport["cleanup"] = Object.freeze({ databases: 0, objects: 0, temporaryFiles: 0, complete: false });
  try {
    copies = await measure("copy_selection", () => port.selectCopies());
    if (!copies.relational.copyId || !copies.relational.sourceWatermarkAt || !Number.isSafeInteger(copies.relational.encryptedBytes) ||
        copies.relational.encryptedBytes! <= 0 || !Number.isSafeInteger(copies.relational.schemaCount) || copies.relational.schemaCount! < 0 ||
        !Number.isSafeInteger(copies.relational.relationCount) || copies.relational.relationCount! < 0 ||
        !Number.isSafeInteger(copies.relational.migrationCount) || copies.relational.migrationCount! < 0) {
      failureStage = "copy_selection";
      throw new RecoveryRehearsalError("RECOVERY_RELATIONAL_COPY_INVENTORY_INCOMPLETE");
    }
    await measure("target_identity_verification", () => port.verifyTarget(input.target));
    targetVerified = true;
    await measure("download_decrypt_validate", () => port.verifyKeysAndCopies(copies!));
    await measure("quarantine", () => port.enterQuarantine());
    await measure("relational_restore", () => port.restoreRelational(copies!));
    const object = await measure("object_copy_selection", () => port.selectObjectCopy(copies!));
    copies = Object.freeze({ ...copies, object });
    if (!object.copyId || !object.sourceWatermarkAt || !Number.isSafeInteger(object.encryptedBytes) || object.encryptedBytes! <= 0 ||
        !Number.isSafeInteger(object.objectCount) || object.objectCount! < 0 || object.objectIds.length !== object.objectCount ||
        new Set(object.objectIds).size !== object.objectIds.length || !Number.isSafeInteger(object.mediaBytes) || object.mediaBytes! < 0 ||
        !Number.isSafeInteger(object.exportBytes) || object.exportBytes! < 0 ||
        object.objectCount! > 0 && object.mediaBytes! + object.exportBytes! <= 0) {
      failureStage = "copy_selection";
      throw new RecoveryRehearsalError("RECOVERY_OBJECT_COPY_INVENTORY_INCOMPLETE");
    }
    await measure("object_download_decrypt_validate", () => port.verifyObjectKeysAndCopies(copies!, object));
    await measure("object_restore", () => port.restoreObjects(copies!, object));
    deletionLedger = await measure("deletion_reconciliation", () => port.reconcileCurrentDeletionLedger());
    await measure("credential_and_grant_reconciliation", () => port.resetCredentialsAndReconcileGrants());
    effects = await measure("queue_and_effect_reconciliation", () => port.reconcileRecoveredEffects());
    if (effects.unresolved !== 0) throw new RecoveryRehearsalError("RECOVERY_EXTERNAL_EFFECTS_UNRESOLVED");
    await measure("projection_rebuild", () => port.rebuildProjections());
    domain = await measure("domain_verification", () => port.verifyDomainMeaning());
    rls = await measure("restricted_rls_and_readiness", () => port.verifyRestrictedRlsAndReadiness());
    if (!rls.ready || rls.allowCases < 1 || rls.denyCases < 1) throw new RecoveryRehearsalError("RECOVERY_READINESS_FAILED");
    verifiedAt = port.now();
    const startedMilliseconds = Date.parse(input.startedAt);
    const verifiedMilliseconds = Date.parse(verifiedAt);
    if (!Number.isFinite(verifiedMilliseconds) || verifiedMilliseconds < startedMilliseconds) {
      failureStage = "timing_qualification";
      throw new RecoveryRehearsalError("RECOVERY_CLOCK_ORDER_INVALID");
    }
    if (manualPauseMilliseconds > verifiedMilliseconds - startedMilliseconds) {
      failureStage = "timing_qualification";
      throw new RecoveryRehearsalError("RECOVERY_MANUAL_PAUSE_EXCEEDS_WALL_TIME");
    }
    const relationalRpoHours = hoursBetween(input.referenceAt, copies.relational.sourceWatermarkAt);
    const mediaRpoHours = hoursBetween(input.referenceAt, copies.object?.sourceWatermarkAt ?? null);
    // startedAt is captured after copy discovery and access; add that separately
    // measured interval. Manual pauses occur after startedAt and remain in the
    // wall-clock interval, so they are reported but not added a second time.
    measuredRtoMilliseconds = discoveryAccessMilliseconds + Date.parse(verifiedAt) - Date.parse(input.startedAt);
    if (!Number.isSafeInteger(measuredRtoMilliseconds) || measuredRtoMilliseconds < 0) {
      failureStage = "timing_qualification";
      throw new RecoveryRehearsalError("RECOVERY_CLOCK_ORDER_INVALID");
    }
    if (!domainComplete(domain)) {
      failureStage = "domain_verification";
      throw new RecoveryRehearsalError("RECOVERY_ACCEPTANCE_TARGET_FAILED");
    }
    if (relationalRpoHours === null || mediaRpoHours === null || relationalRpoHours > input.relationalRpoHours ||
        mediaRpoHours > input.mediaRpoHours || measuredRtoMilliseconds > input.rtoTargetMilliseconds) {
      failureStage = "timing_qualification";
      throw new RecoveryRehearsalError("RECOVERY_ACCEPTANCE_TARGET_FAILED");
    }
    await measure("quarantine_release", () => port.releaseQuarantine());
    accessReleased = true;
  } catch (error) {
    failureCode = safeFailureCode(error, "RECOVERY_REHEARSAL_FAILED");
    if (failureCode.startsWith("OBJECT_BACKUP_")) {
      failureCode = "RECOVERY_OBJECT_COPY_INVALID";
    } else if (failureCode === "BACKUP_KEY_MISSING" || failureCode.startsWith("BACKUP_ENVELOPE_")) {
      failureCode = "RECOVERY_COPY_OR_KEY_INVALID";
    }
  } finally {
    if (targetVerified) {
      try { cleanup = await measure("owned_resource_cleanup", () => port.cleanupOwnedTargets()); }
      catch { cleanup = Object.freeze({ databases: 0, objects: 0, temporaryFiles: 0, complete: false }); }
    }
  }

  if (!cleanup.complete && failureCode === null) {
    failureStage = "owned_resource_cleanup";
    failureCode = "RECOVERY_CLEANUP_INCOMPLETE";
  }
  const relationalRpoHours = hoursBetween(input.referenceAt, copies?.relational.sourceWatermarkAt ?? null);
  const mediaRpoHours = hoursBetween(input.referenceAt, copies?.object?.sourceWatermarkAt ?? null);
  let incident: RecoveryRehearsalReport["incident"] = null;
  if (failureCode !== null) {
    const observedFailureCode = failureCode;
    let recorded = false;
    try { await port.recordSafeIncident(observedFailureCode); recorded = true; }
    catch { failureCode = "RECOVERY_INCIDENT_RECORD_FAILED"; }
    incident = Object.freeze({ code: observedFailureCode, recorded });
  }
  return Object.freeze({
    status: failureCode === null ? "complete" : "failed",
    releaseBlocker: failureCode !== null,
    accessReleased,
    referenceAt: input.referenceAt,
    relationalWatermarkAt: copies?.relational.sourceWatermarkAt ?? null,
    mediaWatermarkAt: copies?.object?.sourceWatermarkAt ?? null,
    relationalRpoHours,
    mediaRpoHours,
    relationalBytes: copies?.relational.encryptedBytes ?? null,
    mediaBytes: copies?.object?.mediaBytes ?? null,
    exportBytes: copies?.object?.exportBytes ?? null,
    objectCount: copies?.object?.objectCount ?? null,
    schemaCount: copies?.relational.schemaCount ?? null,
    relationCount: copies?.relational.relationCount ?? null,
    migrationCount: copies?.relational.migrationCount ?? null,
    domain, deletionLedger, effects, rls,
    startedAt: input.startedAt,
    verifiedAt,
    measuredRtoMilliseconds,
    manualPauseMilliseconds,
    discoveryAccessMilliseconds,
    stageMilliseconds: Object.freeze({ ...stageMilliseconds }),
    failureStage,
    failureCode,
    incident,
    cleanup,
  });
}
