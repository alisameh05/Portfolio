/** Stop and remove every isolated project in reverse creation order. */
export function cleanupIsolatedProjects(projects, { stop, remove }) {
  const failures = [];
  for (const project of [...projects].reverse()) {
    try {
      stop(project);
      remove(project.workdir);
    } catch {
      failures.push(project.projectId);
    }
  }
  return failures;
}

/**
 * Decide whether platform markers describe an initialized Phase 2 baseline
 * under this repository's local topology.
 *
 * The local Supabase stack disables Storage (see supabase/config.toml), so a
 * fresh baseline keeps `auth.users` while `storage.objects` stays absent. A
 * present storage marker would hide topology drift. The migration-history
 * table itself may be absent before the first `migration up`; empty history
 * is verified separately, so its presence is not a platform marker.
 */
export function isPhase2BaselineMarkers({ auth, storage }) {
  return auth === true && storage === false;
}

const PHASE3_TABLES = Object.freeze([
  "operations.idempotency_records",
  "operations.outbox_events",
  "operations.jobs",
]);

/** Require every Phase 3 operations table to exist with forced row security. */
export function assertPhase3Rls(objects) {
  const tables = new Map(
    objects
      .filter((row) => row.kind === "r")
      .map((row) => [`${row.schema}.${row.name}`, row]),
  );
  for (const name of PHASE3_TABLES) {
    const table = tables.get(name);
    if (!table) throw new Error("PHASE3_EXPECTED_TABLE_MISSING");
    if (table.rls_enabled !== true || table.rls_forced !== true) {
      throw new Error("PHASE3_TABLE_RLS_NOT_ENFORCED");
    }
  }
}

/** Fail if clean and upgrade database snapshots differ in any captured state. */
export function assertBaselineSnapshotsEquivalent(clean, upgrade) {
  if (JSON.stringify(clean) !== JSON.stringify(upgrade)) {
    throw new Error("CLEAN_AND_UPGRADE_BASELINES_DIFFER");
  }
}

/** Remove a temporary login's capability before dropping the role. */
export async function cleanupProbeRole({ admin, probe, login, role }) {
  let failed = false;
  for (const statement of [
    `revoke ${role} from "${login}"`,
    `alter role "${login}" nologin`,
  ]) {
    try {
      await admin.query(statement);
    } catch {
      failed = true;
    }
  }
  try {
    await probe.end();
  } catch {
    failed = true;
  }
  try {
    await admin.query(`drop role if exists "${login}"`);
  } catch {
    failed = true;
  }
  try {
    await admin.end();
  } catch {
    failed = true;
  }
  if (failed) throw new Error("PROBE_ROLE_CLEANUP_FAILED");
}

/**
 * List created function names missing an explicit object-level revoke from
 * public clients. PostgreSQL 17 does not apply default-privilege entries to new
 * functions (their system default stays PUBLIC EXECUTE), so every created
 * function must carry its own `REVOKE ... FROM public, anon, authenticated`.
 * Matching uses the complete normalized schema, name, and argument signature.
 */
export function findUnrevokedFunctions(source) {
  const normalized = source.toLowerCase();
  const functionIdentities = (pattern) => {
    const identities = [];
    for (const match of normalized.matchAll(pattern)) {
      const open = match.index + match[0].lastIndexOf("(");
      let depth = 1;
      let close = open + 1;
      while (close < normalized.length && depth > 0) {
        if (normalized[close] === "(") depth += 1;
        if (normalized[close] === ")") depth -= 1;
        close += 1;
      }
      if (depth === 0) {
        const args = normalized
          .slice(open + 1, close - 1)
          .replace(/\s*,\s*/g, ",")
          .replace(/\s+/g, " ")
          .trim();
        identities.push({ identity: `${match[1]}(${args})`, index: match.index });
      }
    }
    return identities;
  };
  const created = functionIdentities(
    /create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_.]*)\s*\(/g,
  );
  const revoked = new Set();
  for (const { identity, index } of functionIdentities(
    /revoke\s+[a-z,\s]+\s+on\s+function\s+([a-z_][a-z0-9_.]*)\s*\(/g,
  )) {
    const end = normalized.indexOf(";", index);
    const tail = normalized.slice(index, end < 0 ? undefined : end + 1);
    if (
      /from\s+[^;]*\bpublic\b/.test(tail) &&
      /from\s+[^;]*\banon\b/.test(tail) &&
      /from\s+[^;]*\bauthenticated\b/.test(tail)
    ) {
      revoked.add(identity);
    }
  }
  return created.map(({ identity }) => identity).filter((name) => !revoked.has(name)).sort();
}
