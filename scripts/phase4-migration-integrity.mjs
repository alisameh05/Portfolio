import { migrationSha256 } from "./migration-checksum.mjs";
import { Client } from "pg";

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

export function assertPhase4SnapshotsEquivalent(clean, upgrade) {
  const stableClean = stable(clean);
  const stableUpgrade = stable(upgrade);
  if (JSON.stringify(stableClean) === JSON.stringify(stableUpgrade)) return;
  const fields = [...new Set([...Object.keys(stableClean), ...Object.keys(stableUpgrade)])]
    .filter((key) => JSON.stringify(stableClean[key]) !== JSON.stringify(stableUpgrade[key]));
  throw new Error(`PORTFOLIO_SETTINGS_DATABASE_STATE_DIFFER:${fields.join(",")}`);
}

export function assertPhase4ApplicationRls(snapshot) {
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
    if (policies.length === 0 || policies.some((policy) =>
      (policy.command !== "INSERT" && policy.usingPredicate === "") ||
      (["INSERT", "UPDATE", "ALL"].includes(policy.command) && policy.withCheck === ""),
    )) {
      throw new Error("PHASE4_APPLICATION_POLICY_PREDICATE_MISSING");
    }
  }
  const publicGrants = snapshot.grants.filter((grant) =>
    APPLICATION_SCHEMAS.includes(grant.schema) &&
    ["PUBLIC", "anon", "authenticated", "shipwithali_worker"].includes(grant.grantee) &&
    (grant.objectType === "n" || grant.privilege !== "USAGE"),
  );
  if (publicGrants.length > 0) throw new Error("PHASE4_APPLICATION_GRANT_EXPOSURE");
  const unauthorizedBackupGrants = snapshot.grants.filter((grant) =>
    grant.grantee === "shipwithali_backup" &&
    !(grant.objectType === "n" && grant.schema === "identity_access" && grant.privilege === "USAGE") &&
    !(grant.schema === "identity_access" && grant.object === "owner_links" && grant.privilege === "SELECT") &&
    !(grant.objectType === "n" && grant.schema === "operations" && grant.privilege === "USAGE") &&
    !(grant.schema === "operations" &&
      ["idempotency_records", "outbox_events", "jobs"].includes(grant.object) && grant.privilege === "SELECT"),
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
    operationsSchema: snapshot.schemas.filter((schema) => schema.name === "operations"),
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

export function assertPhase3OperationsContractPreserved(phase3, upgraded) {
  assertPhase4SnapshotsEquivalent(phase3OperationsContract(phase3), phase3OperationsContract(upgraded));
}

export function assertPhase3OperationsRls(snapshot) {
  for (const name of [
    "operations.idempotency_records", "operations.outbox_events", "operations.jobs",
  ]) {
    const table = snapshot.objects.find((object) => `${object.schema}.${object.name}` === name);
    if (table?.rlsEnabled !== true || table.rlsForced !== true) {
      throw new Error("PHASE3_OPERATIONS_RLS_NOT_FORCED");
    }
  }
}
