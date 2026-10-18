import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localValidationFixture } from "./local-migration-bootstrap.mjs";

export function createPhase3GateProject(root) {
  const projectId = `shipwithali-phase3-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const workdir = mkdtempSync(join(tmpdir(), `${projectId}-`));
  const directory = join(workdir, "supabase");
  mkdirSync(join(directory, "migrations"), { recursive: true });
  const basePort = 53000 + (process.pid % 400) * 20;
  const config = readFileSync(join(root, "supabase/config.toml"), "utf8")
    .replace('project_id = "shipwithali-portfolio"', `project_id = "${projectId}"`)
    .replace(/\bport = 543(\d\d)\b/gu, (_, suffix) => `port = ${basePort + Number(suffix) - 20}`);
  writeFileSync(join(directory, "config.toml"), config);
  copyFileSync(join(root, "supabase/seed.sql"), join(directory, "seed.sql"));
  for (const name of readdirSync(join(root, "supabase/migrations")).filter(name => /^\d{14}_.+\.sql$/u.test(name))) {
    copyFileSync(join(root, "supabase/migrations", name), join(directory, "migrations", name));
  }
  return localValidationFixture(workdir);
}

export function removePhase3GateProject(project) {
  const actual = localValidationFixture(project.workdir);
  if (!/^shipwithali-phase3-[a-f0-9]{16}$/u.test(project.projectId) || actual.projectId !== project.projectId) {
    throw new Error("PHASE3_PROJECT_CLEANUP_SCOPE_INVALID");
  }
  rmSync(project.workdir, { recursive: true, force: true });
}

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
