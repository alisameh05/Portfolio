export const REQUIRED_PHASE3_CHECK_NAMES = Object.freeze([
  "phase2-gate", "phase2-report-runtime", "database-toolchain", "migration-clean-upgrade-equivalence",
  "local-database-start", "local-database-reset", "phase3-focused-tests", "role-rls-types-plans",
  "strict-typecheck", "deterministic-lint", "architecture", "local-database-stop",
]);

export function skippedTestCount(output) {
  const normalized = output.replaceAll(/\u001B\[[0-9;]*m/g, "");
  const patterns = [
    /(?:^|\n)\s*Tests?\s+[^\r\n]*?\b(\d+)\s+skipped\b/giu,
    /\b(\d+)\s+tests?\s+skipped\b/giu,
    /\bSkipped:\s*(\d+)\b/giu,
  ];
  for (const pattern of patterns) {
    const counts = [...normalized.matchAll(pattern)].map((match) => Number(match[1]));
    if (counts.length > 0) return Math.max(...counts);
  }
  return 0;
}
