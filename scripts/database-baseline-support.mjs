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
 * List created function names missing an explicit object-level revoke from
 * public clients. PostgreSQL 17 does not apply default-privilege entries to new
 * functions (their system default stays PUBLIC EXECUTE), so every created
 * function must carry its own `REVOKE ... FROM public, anon, authenticated`.
 * Matching uses short object names, so schema-qualified creates pair with
 * schema-qualified or bare revokes.
 */
export function findUnrevokedFunctions(source) {
  const normalized = source.toLowerCase();
  const created = new Set();
  for (const match of normalized.matchAll(
    /create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_.]*)\s*\(/g,
  )) {
    created.add(match[1]);
  }
  const revoked = new Set();
  for (const match of normalized.matchAll(
    /revoke\s+[a-z,\s]+\s+on\s+function\s+([a-z_][a-z0-9_.]*)\s*\(/g,
  )) {
    const tail = normalized.slice(match.index, match.index + 240);
    if (
      /from\s+[^;]*\bpublic\b/.test(tail) &&
      /from\s+[^;]*\banon\b/.test(tail) &&
      /from\s+[^;]*\bauthenticated\b/.test(tail)
    ) {
      revoked.add(match[1]);
    }
  }
  const shortName = (name) => (name.includes(".") ? name.split(".").pop() : name);
  const revokedShort = new Set([...revoked].map(shortName));
  return [...created].filter((name) => !revokedShort.has(shortName(name))).sort();
}
