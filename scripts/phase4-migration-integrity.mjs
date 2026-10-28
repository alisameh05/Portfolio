import { migrationSha256 } from "./migration-checksum.mjs";
import {
  composeOperationsBoundary,
  PHASE4_RELEASE_BOUNDARY,
  PHASE_DECLARED_ADDITIVE_MIGRATIONS,
  PHASE5_MIGRATION_COMPATIBILITY,
  PHASE5_MIGRATION_FIRST,
  PHASE5_MIGRATION_LAST,
  PHASE_DATABASE_TRANSFORMATIONS,
  resolveMigrationClassifications,
} from "./phase-contract-registry.mjs";
import { ValidationFailure } from "./validation-errors.mjs";
import { Client } from "pg";

export { PHASE5_MIGRATION_COMPATIBILITY };

export const PHASE4_APPLICATION_TABLES = Object.freeze([
  "identity_access.owner_links",
  "portfolio_config.contact_channels",
  "portfolio_config.settings",
]);

const APPLICATION_SCHEMAS = ["identity_access", "portfolio_config"];
const SNAPSHOT_SCHEMAS = [
  "content", "cv", "identity_access", "interaction", "media", "measurement",
  "operations", "portfolio_config", "public_read", "taxonomy",
];
const CAPABILITY_ROLES = [
  "shipwithali_application", "shipwithali_backup", "shipwithali_migration", "shipwithali_worker",
];
const SETTINGS_SCOPE_PREDICATE = "(((portfolio_id)::text = current_setting('shipwithali.portfolio_id'::text, true)) AND ((owner_id)::text = current_setting('shipwithali.owner_id'::text, true)))";
const CHANNEL_SCOPE_PREDICATE = "(((portfolio_id)::text = current_setting('shipwithali.portfolio_id'::text, true)) AND (EXISTS ( SELECT 1 FROM portfolio_config.settings settings WHERE ((settings.portfolio_id = contact_channels.portfolio_id) AND ((settings.owner_id)::text = current_setting('shipwithali.owner_id'::text, true))))))";
const CONFIGURATION_EXPORT_SETTINGS_SCOPE_PREDICATE = "(((portfolio_id)::text = nullif(current_setting('shipwithali.portfolio_id'::text, true), ''::text)) AND ((owner_id)::text = nullif(current_setting('shipwithali.owner_id'::text, true), ''::text)))";
const CONFIGURATION_EXPORT_CHANNEL_SCOPE_PREDICATE = "(((portfolio_id)::text = nullif(current_setting('shipwithali.portfolio_id'::text, true), ''::text)) AND (EXISTS ( SELECT 1 FROM portfolio_config.settings settings WHERE ((settings.portfolio_id = contact_channels.portfolio_id) AND ((settings.owner_id)::text = nullif(current_setting('shipwithali.owner_id'::text, true), ''::text))))))";
const PHASE4_APPLICATION_POLICIES = new Map([
  ["identity_access.owner_links", [
    ["owner_links_application_select_policy", "SELECT", "{shipwithali_application}", "true"],
    ["owner_links_application_insert_policy", "INSERT", "{shipwithali_application}", "true"],
    ["owner_links_application_update_policy", "UPDATE", "{shipwithali_application}", "true"],
    ["owner_links_backup_policy", "SELECT", "{shipwithali_backup}", "true"],
  ]],
  ["portfolio_config.settings", [
    ["portfolio_settings_application_select", "SELECT", "{shipwithali_application}", SETTINGS_SCOPE_PREDICATE],
    ["portfolio_settings_application_insert", "INSERT", "{shipwithali_application}", SETTINGS_SCOPE_PREDICATE],
    ["portfolio_settings_application_update", "UPDATE", "{shipwithali_application}", SETTINGS_SCOPE_PREDICATE],
  ]],
  ["portfolio_config.contact_channels", [
    ["portfolio_channels_application_select", "SELECT", "{shipwithali_application}", CHANNEL_SCOPE_PREDICATE],
    ["portfolio_channels_application_insert", "INSERT", "{shipwithali_application}", CHANNEL_SCOPE_PREDICATE],
    ["portfolio_channels_application_delete", "DELETE", "{shipwithali_application}", CHANNEL_SCOPE_PREDICATE],
  ]],
]);
const CONFIGURATION_EXPORT_WORKER_POLICIES = new Map([
  ["portfolio_config.settings", [
    ["portfolio_settings_worker_export_select", "SELECT", "{shipwithali_worker}", CONFIGURATION_EXPORT_SETTINGS_SCOPE_PREDICATE],
  ]],
  ["portfolio_config.contact_channels", [
    ["portfolio_channels_worker_export_select", "SELECT", "{shipwithali_worker}", CONFIGURATION_EXPORT_CHANNEL_SCOPE_PREDICATE],
  ]],
]);


export function phase4ReleaseMigrationFiles(files) {
  return [...files].filter((file) => file.localeCompare(PHASE4_RELEASE_BOUNDARY) < 0);
}

export function migrationsAfterPhase5(files) {
  return [...files].filter((file) => file.localeCompare(PHASE5_MIGRATION_LAST) > 0);
}

export function roleMembershipContract(rows) {
  return [...rows]
    .map(({ role, member, adminOption }) => JSON.stringify([role, member, adminOption]))
    .sort();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function validatePhase3MigrationSnapshot(snapshot, phase3Files, contentsByName) {
  if (snapshot?.release !== "phase-3" || snapshot.migrations === null || typeof snapshot.migrations !== "object") {
    throw new Error("PHASE3_MIGRATION_SNAPSHOT_INVALID");
  }
  const expectedFiles = Object.keys(snapshot.migrations).sort();
  const actualFiles = [...phase3Files].sort();
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error("PHASE3_MIGRATION_SNAPSHOT_SOURCE_MISMATCH");
  }
  for (const file of actualFiles) {
    const contents = contentsByName.get(file);
    if (typeof contents !== "string") throw new Error("PHASE3_MIGRATION_SNAPSHOT_SOURCE_MISMATCH");
    if (migrationSha256(contents) !== snapshot.migrations[file]) {
      throw new Error("PHASE3_MIGRATION_SNAPSHOT_CHECKSUM_MISMATCH");
    }
  }
  return actualFiles;
}

export function assertPhase5MigrationSafety(files, contentsByName, compatibility = PHASE5_MIGRATION_COMPATIBILITY) {
  const phase5Files = [...files].filter((file) =>
    file.localeCompare(PHASE5_MIGRATION_FIRST) >= 0 && file.localeCompare(PHASE5_MIGRATION_LAST) <= 0);
  if (phase5Files.length === 0) throw new Error("PHASE5_MIGRATIONS_MISSING");
  for (const file of phase5Files) {
    if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(file)) throw new Error("PHASE5_MIGRATION_NAME_INVALID");
    const source = contentsByName.get(file);
    if (typeof source !== "string") throw new Error("PHASE5_MIGRATION_SOURCE_MISSING");
    const audit = compatibility[file];
    if (audit === undefined || !["expand", "lockstep"].includes(audit.stage) ||
      typeof audit.boundary !== "string" || audit.boundary.trim() === "" ||
      audit.priorWriterCompatible !== (audit.stage === "expand")) {
      throw new Error("PHASE5_MIGRATION_COMPATIBILITY_UNDOCUMENTED");
    }
    if (!/set\s+lock_timeout\s*=\s*'5s'\s*;/i.test(source)) {
      throw new Error("PHASE5_MIGRATION_LOCK_TIMEOUT_MISSING");
    }
    if (!/^\s*--\s*rollback\s*:/im.test(source)) throw new Error("PHASE5_MIGRATION_ROLLBACK_NOTE_MISSING");
    if (!/^\s*--\s*(?:forward\s+fix|rollback)\s*:/im.test(source)) {
      throw new Error("PHASE5_MIGRATION_RECOVERY_LIMITATION_MISSING");
    }
    if (/\b(?:drop\s+(?:table|column|type|schema)|truncate\s+(?:table\s+)?)/i.test(source)) {
      throw new Error("PHASE5_UNREVIEWED_DESTRUCTIVE_CONTRACTION");
    }
  }
  return phase5Files;
}

export function assertPhase4SnapshotsEquivalent(clean, upgrade) {
  const stableClean = stable(clean);
  const stableUpgrade = stable(upgrade);
  if (JSON.stringify(stableClean) === JSON.stringify(stableUpgrade)) return;
  const fields = [...new Set([...Object.keys(stableClean), ...Object.keys(stableUpgrade)])]
    .filter((key) => JSON.stringify(stableClean[key]) !== JSON.stringify(stableUpgrade[key]));
  const details = fields
    .filter((key) => ["grants", "policies", "roleMemberships"].includes(key))
    .map((key) => {
      const identity = (row) => key === "grants"
        ? `${row.schema}.${row.object}:${row.grantee}:${row.privilege}`
        : key === "policies"
          ? `${row.schema}.${row.tableName}:${row.name}:${row.roles}:${row.command}`
          : `${row.role}:${row.member}:${row.adminOption}`;
      const cleanRows = new Set((stableClean[key] ?? []).map(identity));
      const upgradeRows = new Set((stableUpgrade[key] ?? []).map(identity));
      const onlyClean = [...cleanRows].filter((value) => !upgradeRows.has(value)).sort();
      const onlyUpgrade = [...upgradeRows].filter((value) => !cleanRows.has(value)).sort();
      return `${key}[clean-only:${onlyClean.join("|")};upgrade-only:${onlyUpgrade.join("|")}]`;
    });
  throw new Error(`PORTFOLIO_SETTINGS_DATABASE_STATE_DIFFER:${fields.join(",")}${details.length ? `:${details.join(";")}` : ""}`);
}

export function assertPhase4ApplicationRls(snapshot) {
  const configurationExportApplied = snapshot.migrationLedger?.some((migration) =>
    migration.name === "build_configuration_owner_exports",
  ) === true;
  const phase7DurableScheduleApplied = snapshot.migrationLedger?.some((migration) =>
    migration.name === "phase7_durable_policy_schedule_keys",
  ) === true;
  const tables = new Map(
    snapshot.objects.filter((object) => object.kind === "r")
      .map((object) => [`${object.schema}.${object.name}`, object]),
  );
  for (const name of PHASE4_APPLICATION_TABLES) {
    const table = tables.get(name);
    if (table?.rlsEnabled !== true || table.rlsForced !== true) {
      throw new Error("PHASE4_APPLICATION_TABLE_RLS_NOT_FORCED");
    }
    const policies = snapshot.policies.filter((policy) =>
      `${policy.schema}.${policy.tableName}` === name,
    );
    const baseExpected = PHASE4_APPLICATION_POLICIES.get(name);
    const expected = baseExpected === undefined ? undefined : [
      ...baseExpected,
      ...(configurationExportApplied ? CONFIGURATION_EXPORT_WORKER_POLICIES.get(name) ?? [] : []),
    ];
    const byName = new Map(policies.map((policy) => [policy.name, policy]));
    if (expected === undefined || policies.length !== expected.length || byName.size !== expected.length ||
      expected.some(([policyName, command, roles, scope]) => {
        const policy = byName.get(policyName);
        if (policy === undefined || policy.command !== command || policy.roles !== roles || policy.permissive !== "permissive") return true;
        const predicates = command === "UPDATE"
          ? [policy.usingPredicate, policy.withCheck]
          : [command === "INSERT" ? policy.withCheck : policy.usingPredicate];
        return predicates.some((predicate) => {
          if (scope === "true") return predicate.trim().toLowerCase() !== "true";
          const normalized = predicate.toLowerCase().replaceAll(/\s+/g, "");
          const expectedPredicate = scope.toLowerCase().replaceAll(/\s+/g, "");
          return normalized !== expectedPredicate;
        });
      })) {
      throw new Error("PHASE4_APPLICATION_POLICY_PREDICATE_MISSING");
    }
  }
  const publicGrants = snapshot.grants.filter((grant) =>
    APPLICATION_SCHEMAS.includes(grant.schema) &&
    ["PUBLIC", "anon", "authenticated", "shipwithali_worker"].includes(grant.grantee) &&
    (grant.objectType === "n" || grant.privilege !== "USAGE") &&
    !(configurationExportApplied && grant.schema === "portfolio_config" &&
      grant.grantee === "shipwithali_worker" && grant.grantable !== true && (
        (grant.objectType === "n" && grant.object === "portfolio_config" && grant.privilege === "USAGE") ||
        (grant.objectType === "r" && ["settings", "contact_channels"].includes(grant.object) &&
          grant.privilege === "SELECT")
      )),
  );
  if (publicGrants.length > 0) throw new Error("PHASE4_APPLICATION_GRANT_EXPOSURE");
  const unauthorizedBackupGrants = snapshot.grants.filter((grant) =>
    grant.grantee === "shipwithali_backup" &&
    !(grant.objectType === "n" && grant.schema === "identity_access" && grant.privilege === "USAGE") &&
    !(grant.schema === "identity_access" && grant.object === "owner_links" && grant.privilege === "SELECT") &&
    !(grant.objectType === "n" && grant.schema === "operations" && grant.privilege === "USAGE") &&
    !(grant.schema === "operations" &&
      ["idempotency_records", "outbox_events", "jobs", "incidents", "job_redrive_audit"].includes(grant.object) &&
      grant.privilege === "SELECT") &&
    !(phase7DurableScheduleApplied && grant.schema === "operations" && grant.object === "phase7_schedule_progress" &&
      grant.objectType === "r" && grant.privilege === "SELECT") &&
    !(grant.schema === "media" && grant.objectType === "r" && grant.privilege === "SELECT" && new Set([
      "acceptance_commands",
      "assets",
      "decision_history",
      "processed_objects",
      "processing_attempt_outputs",
      "processing_attempt_variants",
      "processing_attempts",
      "processing_claims",
      "processing_commands",
      "processing_orphans",
      "processing_states",
      "rejection_history",
    ]).has(grant.object)) &&
    !(grant.schema === "measurement" && grant.objectType === "r" && grant.privilege === "SELECT" && new Set([
      "daily_aggregates",
      "daily_aggregate_checkpoints",
    ]).has(grant.object)),
  );
  if (unauthorizedBackupGrants.length > 0) throw new Error("PHASE4_BACKUP_CONFIGURATION_GRANT");
  const unsafeDefaults = snapshot.defaultPrivileges.filter((grant) =>
    APPLICATION_SCHEMAS.includes(grant.schema) &&
    ["PUBLIC", "anon", "authenticated", "shipwithali_worker"].includes(grant.grantee),
  );
  if (unsafeDefaults.length > 0) throw new Error("PHASE4_APPLICATION_DEFAULT_GRANT_EXPOSURE");
}

export async function snapshotPhase4Database(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  let stage = "schemas";
  try {
    const serverVersion = await client.query(
      "select version() as version, current_setting('server_version_num')::integer as \"serverVersionNum\"",
    );
    const serverVersionNum = serverVersion.rows[0]?.serverVersionNum;
    const postgresMajor = typeof serverVersionNum === "number" && serverVersionNum >= 100000
      ? Math.floor(serverVersionNum / 10000)
      : null;
    if (postgresMajor !== 17 && postgresMajor !== 18) throw new Error(`PHASE4_POSTGRES_MAJOR_UNSUPPORTED:${postgresMajor ?? "unknown"}`);
    const schemas = await client.query(
      `select n.nspname as name, pg_get_userbyid(n.nspowner) as owner,
              coalesce(n.nspacl::text, '') as acl
         from pg_namespace n where n.nspname = any($1::text[]) order by n.nspname`,
      [SNAPSHOT_SCHEMAS],
    );
    stage = "roles";
    const roles = await client.query(
      `select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
              rolreplication, rolbypassrls
         from pg_roles where rolname = any($1::text[]) order by rolname`,
      [CAPABILITY_ROLES],
    );
    stage = "objects";
    const objects = await client.query(
      `select n.nspname as schema, c.relname as name, c.relkind as kind,
              pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as "rlsEnabled",
              c.relforcerowsecurity as "rlsForced"
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1::text[]) and c.relkind in ('r','p','v','m','S')
        order by n.nspname, c.relname, c.relkind`,
      [SNAPSHOT_SCHEMAS],
    );
    stage = "constraints";
    const constraints = await client.query(
      `select n.nspname as schema, c.relname as "tableName", con.conname as name,
              con.contype as type, con.convalidated as validated,
              pg_get_constraintdef(con.oid, true) as definition
         from pg_constraint con join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1::text[]) order by n.nspname, c.relname, con.conname`,
      [SNAPSHOT_SCHEMAS],
    );
    stage = "columns";
    const columns = await client.query(
      `select table_schema as schema, table_name as "tableName", ordinal_position as "position",
              column_name as name, data_type as "type", udt_schema as "typeSchema",
              udt_name as "typeName", is_nullable as nullable, column_default as "default",
              is_identity as "identity", identity_generation as "identityGeneration",
              is_generated as "generated", generation_expression as "generationExpression",
              character_maximum_length as "characterMaximumLength",
              numeric_precision as "numericPrecision", numeric_scale as "numericScale",
              datetime_precision as "datetimePrecision"
         from information_schema.columns where table_schema = any($1::text[])
        order by table_schema, table_name, ordinal_position`,
      [SNAPSHOT_SCHEMAS],
    );
    stage = "policies";
    const policies = await client.query(
      `select schemaname as schema, tablename as "tableName", policyname as name,
              lower(permissive) as permissive, roles, cmd as command,
              coalesce(qual, '') as "usingPredicate", coalesce(with_check, '') as "withCheck"
         from pg_policies where schemaname = any($1::text[])
        order by schemaname, tablename, policyname`,
      [SNAPSHOT_SCHEMAS],
    );
    stage = "grants";
    const grants = await client.query(
      `select n.nspname as schema, c.relname as object, c.relkind as "objectType",
              coalesce(grantee.rolname, 'PUBLIC') as grantee,
              grantor.rolname as grantor, acl.privilege_type as privilege,
              acl.is_grantable as grantable
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(coalesce(c.relacl, acldefault(
           case when c.relkind = 'S' then 'S'::"char" else 'r'::"char" end,
           c.relowner
         ))) acl
         left join pg_roles grantee on grantee.oid = acl.grantee
         join pg_roles grantor on grantor.oid = acl.grantor
        where n.nspname = any($1::text[]) and c.relkind in ('r','p','v','m','S')
        union all
       select n.nspname, n.nspname, 'n', coalesce(grantee.rolname, 'PUBLIC'), grantor.rolname,
              acl.privilege_type, acl.is_grantable
         from pg_namespace n
         cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) acl
         left join pg_roles grantee on grantee.oid = acl.grantee
         join pg_roles grantor on grantor.oid = acl.grantor
        where n.nspname = any($1::text[])
        union all
       select n.nspname, c.relname || '.' || a.attname, 'column',
              coalesce(grantee.rolname, 'PUBLIC'), grantor.rolname,
              acl.privilege_type, acl.is_grantable
         from pg_attribute a join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(a.attacl) acl
         left join pg_roles grantee on grantee.oid = acl.grantee
         join pg_roles grantor on grantor.oid = acl.grantor
        where n.nspname = any($1::text[]) and a.attnum > 0 and not a.attisdropped and a.attacl is not null
        union all
       select n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
              'f', coalesce(grantee.rolname, 'PUBLIC'), grantor.rolname,
              acl.privilege_type, acl.is_grantable
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
         left join pg_roles grantee on grantee.oid = acl.grantee
         join pg_roles grantor on grantor.oid = acl.grantor
        where n.nspname = any($1::text[])
        order by 1, 2, 3, 4, 5, 6, 7`,
      [SNAPSHOT_SCHEMAS],
    );
    stage = "default-privileges";
    const defaults = await client.query(
      `select n.nspname as schema, owner.rolname as owner, d.defaclobjtype as "objectType",
              coalesce(grantee.rolname, 'PUBLIC') as grantee, grantor.rolname as grantor,
              acl.privilege_type as privilege, acl.is_grantable as grantable
         from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
         join pg_roles owner on owner.oid = d.defaclrole
         cross join lateral aclexplode(d.defaclacl) acl
         left join pg_roles grantee on grantee.oid = acl.grantee
         join pg_roles grantor on grantor.oid = acl.grantor
        where n.nspname = any($1::text[])
        order by n.nspname, owner.rolname, d.defaclobjtype, 4, 5, 6, 7`,
      [SNAPSHOT_SCHEMAS],
    );
    stage = "indexes";
    const indexes = await client.query(
      `select schemaname as schema, tablename as table, indexname as name, indexdef as definition
         from pg_indexes where schemaname = any($1::text[]) order by schemaname, tablename, indexname`,
      [SNAPSHOT_SCHEMAS],
    );
    stage = "functions";
    const functions = await client.query(
      `select n.nspname as schema, p.proname as name,
              pg_get_function_identity_arguments(p.oid) as arguments,
              p.prosecdef as "securityDefiner", l.lanname as language,
              pg_get_functiondef(p.oid) as definition
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang
        where n.nspname = any($1::text[])
        order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)`,
      [SNAPSHOT_SCHEMAS],
    );
    stage = "triggers";
    const triggers = await client.query(
      `select n.nspname as schema, c.relname as "tableName", t.tgname as name,
              pg_get_triggerdef(t.oid, true) as definition
         from pg_trigger t join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1::text[]) and not t.tgisinternal
        order by n.nspname, c.relname, t.tgname`,
      [SNAPSHOT_SCHEMAS],
    );
    stage = "types";
    const types = await client.query(
      `select n.nspname as schema, t.typname as name, t.typtype as kind,
              array_agg(e.enumlabel order by e.enumsortorder) filter (where e.enumlabel is not null) as labels
         from pg_type t join pg_namespace n on n.oid = t.typnamespace
         left join pg_enum e on e.enumtypid = t.oid
        where n.nspname = any($1::text[]) and t.typtype in ('e','d')
        group by n.nspname, t.typname, t.typtype order by n.nspname, t.typname`,
      [SNAPSHOT_SCHEMAS],
    );
    stage = "migration-ledger";
    const migrationLedger = await client.query(
      "select version, name from supabase_migrations.schema_migrations order by version",
    );
    stage = "role-memberships";
    const roleMemberships = await client.query(
      `select granted.rolname as role, member.rolname as member, m.admin_option as "adminOption"
         from pg_auth_members m join pg_roles granted on granted.oid = m.roleid
         join pg_roles member on member.oid = m.member
        where granted.rolname = any($1::text[]) or member.rolname = any($1::text[])
        order by granted.rolname, member.rolname`,
      [CAPABILITY_ROLES],
    );
    const result = {
      postgresVersion: serverVersion.rows[0]?.version ?? null,
      postgresMajor,
      schemas: schemas.rows,
      roles: roles.rows,
      roleMemberships: roleMemberships.rows,
      objects: objects.rows,
      columns: columns.rows,
      constraints: constraints.rows,
      policies: policies.rows,
      grants: grants.rows,
      defaultPrivileges: defaults.rows,
      indexes: indexes.rows,
      functions: functions.rows,
      triggers: triggers.rows,
      types: types.rows,
      migrationLedger: migrationLedger.rows,
    };
    stage = "capability-role-assertions";
    if (roles.rows.length !== CAPABILITY_ROLES.length) throw new Error("PHASE4_CAPABILITY_ROLE_COUNT_MISMATCH");
    if (schemas.rows.some((row) => row.owner !== "shipwithali_migration")) throw new Error("PHASE4_SCHEMA_OWNER_MISMATCH");
    if (roles.rows.some((role) => role.rolcanlogin || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls)) {
      throw new Error("PHASE4_CAPABILITY_ROLE_BYPASS_OR_LOGIN");
    }
    const phase4TableCount = objects.rows.filter((object) =>
      PHASE4_APPLICATION_TABLES.includes(`${object.schema}.${object.name}`),
    ).length;
    if (phase4TableCount !== 0) assertPhase4ApplicationRls(result);
    return result;
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : error instanceof Error ? error.message : "unknown";
    throw new Error(`PORTFOLIO_SETTINGS_SNAPSHOT_FAILED:${stage}:${code}`);
  } finally {
    await client.end();
  }
}

export function phase3OperationsContract(snapshot) {
  return {
    schemas: snapshot.schemas.filter((schema) => schema.name === "operations"),
    objects: snapshot.objects.filter((object) => object.schema === "operations"),
    columns: snapshot.columns.filter((column) => column.schema === "operations"),
    constraints: snapshot.constraints.filter((constraint) => constraint.schema === "operations"),
    policies: snapshot.policies.filter((policy) => policy.schema === "operations"),
    grants: snapshot.grants.filter((grant) => grant.schema === "operations"),
    defaultPrivileges: snapshot.defaultPrivileges.filter((grant) => grant.schema === "operations"),
    indexes: snapshot.indexes.filter((index) => index.schema === "operations"),
    functions: snapshot.functions.filter((fn) => fn.schema === "operations"),
    triggers: snapshot.triggers.filter((trigger) => trigger.schema === "operations"),
    types: snapshot.types.filter((type) => type.schema === "operations"),
  };
}

export function phase4ReleaseContract(snapshot) {
  return {
    ...snapshot,
    roleMemberships: roleMembershipContract(snapshot.roleMemberships ?? []),
    policies: snapshot.policies,
    grants: snapshot.grants,
  };
}

// The Phase 8 bounded-retry migration (bound_job_retries_and_incidents) is the
// one sanctioned transformation of the Phase 3 operations contract. Its exact
// deltas are declared in the shared registry (scripts/phase-contract-registry.mjs);
// historical gates compose that boundary instead of holding hard-coded ticket
// exceptions. Everything else must survive the upgrade byte-for-byte: any
// undeclared removal, alteration, or addition of existing rows - including
// changed definitions, predicates, types, ownership, grants, or grantability -
// fails with the offending schema path.
const OPERATION_CONTRACT_CATEGORIES = Object.freeze({
  schemas: (row) => row.name,
  objects: (row) => `${row.schema}.${row.name}`,
  columns: (row) => `${row.schema}.${row.tableName}.${row.name}`,
  constraints: (row) => `${row.schema}.${row.tableName}.${row.name}`,
  policies: (row) => `${row.schema}.${row.tableName}.${row.name}`,
  grants: (row) => `${row.schema}.${row.object}.${row.objectType}.${row.grantee}:${row.grantor}:${row.privilege}`,
  defaultPrivileges: (row) => `${row.schema}.${row.owner}.${row.objectType}.${row.grantee}:${row.grantor}:${row.privilege}`,
  indexes: (row) => `${row.schema}.${row.table}.${row.name}`,
  functions: (row) => `${row.schema}.${row.name}(${row.arguments})`,
  triggers: (row) => `${row.schema}.${row.tableName}.${row.name}`,
  types: (row) => `${row.schema}.${row.name}`,
});

function contractRows(snapshot, category) {
  const rows = snapshot[category];
  return Array.isArray(rows) ? rows.filter((row) => row.schema === "operations" || category === "schemas" && row.name === "operations") : [];
}

function jsonEqual(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function firstDifference(left, right, path = "") {
  if (jsonEqual(left, right)) return null;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return path || "value";
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const difference = firstDifference(left[key], right[key], path ? `${path}.${key}` : key);
    if (difference !== null) return difference;
  }
  return path || "value";
}

function catalogIdentity(category, row) {
  const identity = OPERATION_CONTRACT_CATEGORIES[category];
  if (!identity) throw new Error(`PHASE3_OPERATIONS_CONTRACT_CATEGORY_UNKNOWN:${category}`);
  return identity(row);
}

function failPreservation(code, category, identity, suffix = "") {
  throw new ValidationFailure({
    code,
    check: "phase3-operations-preservation",
    categories: [category],
    paths: [`${category}:${identity}${suffix ? `:${suffix}` : ""}`],
    detail: `${category} catalog row ${identity}${suffix ? ` differs at ${suffix}` : " differs from the reviewed contract"}`,
  });
}

function assertUniqueOperationsRows(snapshot, stage) {
  for (const category of Object.keys(OPERATION_CONTRACT_CATEGORIES)) {
    const rows = contractRows(snapshot, category);
    const keys = rows.map((row) => catalogIdentity(category, row));
    const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
    if (duplicate !== undefined) failPreservation("PHASE3_OPERATIONS_CONTRACT_DUPLICATE_IDENTITY", category, duplicate, stage);
  }
}

export function assertPhase3OperationsContractPreserved(phase3, upgraded, {
  transformations = PHASE_DATABASE_TRANSFORMATIONS,
} = {}) {
  if (![17, 18].includes(phase3?.postgresMajor) || ![17, 18].includes(upgraded?.postgresMajor)) {
    throw new ValidationFailure({ code: "PHASE3_OPERATIONS_ENGINE_UNSUPPORTED", check: "phase3-operations-preservation", paths: ["postgresMajor"] });
  }
  if (phase3.postgresMajor !== upgraded.postgresMajor) {
    throw new ValidationFailure({ code: "PHASE3_OPERATIONS_ENGINE_MISMATCH", check: "phase3-operations-preservation", paths: ["postgresMajor"] });
  }
  const expected = phase3OperationsContract(phase3);
  const actual = phase3OperationsContract(upgraded);
  const appliedMigrationNames = new Set((upgraded.migrationLedger ?? []).map((migration) => migration.name));
  const declaredAdditions = PHASE_DECLARED_ADDITIVE_MIGRATIONS
    .filter((migration) => appliedMigrationNames.has(migration.migration.slice(15, -4)))
    .flatMap((migration) => [
      ...(migration.operationsAdditions ?? []),
      ...(migration.operationsAdditionsByEngine?.[String(upgraded.postgresMajor)] ?? []),
    ]);
  for (const addition of declaredAdditions) {
    const rows = actual[addition.category];
    if (!Array.isArray(rows)) throw new Error(`PHASE3_OPERATIONS_CONTRACT_CATEGORY_UNKNOWN:${addition.category}`);
    const index = rows.findIndex((row) => catalogIdentity(addition.category, row) === addition.identity);
    if (index === -1) failPreservation("PHASE3_OPERATIONS_CONTRACT_DECLARED_ADDITION_MISSING", addition.category, addition.identity);
    const actualFields = Object.fromEntries(Object.keys(addition.expected).map((field) => [field, rows[index][field]]));
    const difference = firstDifference(addition.expected, actualFields);
    if (difference !== null) failPreservation("PHASE3_OPERATIONS_CONTRACT_DECLARED_ADDITION_ALTERED", addition.category, addition.identity, difference);
    rows.splice(index, 1);
  }
  assertUniqueOperationsRows(expected, "baseline");
  assertUniqueOperationsRows(actual, "candidate");
  const boundary = composeOperationsBoundary(transformations, phase3.postgresMajor);
  for (const operation of boundary.operations) {
    const rows = expected[operation.category];
    if (!Array.isArray(rows)) throw new Error(`PHASE3_OPERATIONS_CONTRACT_CATEGORY_UNKNOWN:${operation.category}`);
    const key = catalogIdentity(operation.category, operation.after ?? operation.before);
    if (key !== operation.identity) throw new Error(`PHASE3_OPERATIONS_CONTRACT_DECLARATION_IDENTITY_MISMATCH:${operation.category}:${operation.identity}`);
    const index = rows.findIndex((row) => catalogIdentity(operation.category, row) === operation.identity);
    if (operation.before === null) {
      if (index !== -1) failPreservation("PHASE3_OPERATIONS_CONTRACT_DECLARATION_PRECONDITION_FAILED", operation.category, operation.identity);
    } else {
      if (index === -1) failPreservation("PHASE3_OPERATIONS_CONTRACT_DECLARATION_PRECONDITION_FAILED", operation.category, operation.identity);
      const difference = firstDifference(rows[index], operation.before);
      if (difference !== null) failPreservation("PHASE3_OPERATIONS_CONTRACT_DECLARATION_PRECONDITION_FAILED", operation.category, operation.identity, difference);
      rows.splice(index, 1);
    }
    if (operation.after !== null) rows.push(structuredClone(operation.after));
  }
  assertUniqueOperationsRows(expected, "expected");
  for (const category of Object.keys(OPERATION_CONTRACT_CATEGORIES)) {
    const expectedRows = expected[category];
    const actualRows = actual[category];
    const byIdentity = new Map(actualRows.map((row) => [catalogIdentity(category, row), row]));
    const expectedIds = new Set(expectedRows.map((row) => catalogIdentity(category, row)));
    for (const expectedRow of expectedRows) {
      const identity = catalogIdentity(category, expectedRow);
      const actualRow = byIdentity.get(identity);
      if (actualRow === undefined) failPreservation("PHASE3_OPERATIONS_CONTRACT_LOST", category, identity);
      const difference = firstDifference(expectedRow, actualRow);
      if (difference !== null) failPreservation("PHASE3_OPERATIONS_CONTRACT_ALTERED", category, identity, difference);
    }
    for (const actualRow of actualRows) {
      const identity = catalogIdentity(category, actualRow);
      if (!expectedIds.has(identity)) failPreservation("PHASE3_OPERATIONS_CONTRACT_UNEXPECTED_ADDITION", category, identity);
    }
  }
}

export function assertPhase3OperationsRls(snapshot) {
  const protectedTables = ["operations.idempotency_records", "operations.outbox_events", "operations.jobs"];
  if (snapshot.migrationLedger?.some((migration) => migration.name === "phase7_durable_policy_schedule_keys")) {
    protectedTables.push("operations.phase7_schedule_progress");
  }
  for (const name of protectedTables) {
    const table = snapshot.objects.find((object) => `${object.schema}.${object.name}` === name);
    if (table?.rlsEnabled !== true || table.rlsForced !== true) {
      throw new Error("PHASE3_OPERATIONS_RLS_NOT_FORCED");
    }
  }
}
