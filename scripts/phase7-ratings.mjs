import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const root = process.cwd(), runId = randomUUID(), source = workingTreeSourceSha256();
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE7_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;
function run(command, args, env = process.env) {
  const r = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 180_000 });
  if (r.error || r.status !== 0) throw new Error(`RATING_COMMAND_FAILED:${args[0] ?? command}:${r.status ?? "unavailable"}`);
  return r.stdout;
}
const temp = mkdtempSync(join(tmpdir(), "portfolio-ratings-191-"));
const data = join(temp, "data"), reportPath = resolve("artifacts/ratings-vitest.json");
mkdirSync("artifacts", { recursive: true });
rmSync(reportPath, { force: true });
rmSync("evidence/phase7-ratings-191.json", { force: true });
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const p = server.address().port; server.close(() => resolvePort(p)); });
});
const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
const client = new Client({ connectionString: adminUrl });
let started = false, connected = false, result, cleanup = false, stage = "runtime";
try {
  run(process.execPath, ["scripts/validation-environment.mjs"]);
  const version = run(exe("postgres"), ["--version"]).trim();
  stage = "cluster";
  run(exe("initdb"), ["-D", data, "--no-locale", "-A", "trust", "-U", "postgres"]);
  started = true;
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
  await client.connect(); connected = true;
  stage = "baseline";
  await client.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync("supabase/migrations").filter(n => n.endsWith(".sql")).sort();
  for (const name of migrations) { stage = "migration:" + name; await client.query(readFileSync("supabase/migrations/" + name, "utf8")); }
  const migration = "supabase/migrations/20261014211320_persist_project_ratings.sql";
  await client.query("create role rating_runtime login nosuperuser nobypassrls; grant shipwithali_application to rating_runtime; create role reaction_runtime login nosuperuser nobypassrls; grant shipwithali_application to reaction_runtime");
  const env = { ...process.env, PHASE7_RATING_DATABASE_URL: `postgres://rating_runtime@127.0.0.1:${port}/postgres`, PHASE7_RATING_ADMIN_URL: adminUrl, PHASE7_REACTION_DATABASE_URL: `postgres://reaction_runtime@127.0.0.1:${port}/postgres`, PHASE7_REACTION_ADMIN_URL: adminUrl };
  const generated = "src/modules/interaction-moderation/adapters/database.generated.ts";
  stage = "type-generation";
  const codegen = ["node_modules/kysely-codegen/dist/cli/bin.js", "--dialect", "postgres", "--url", "env(PHASE7_RATING_ADMIN_URL)",
    "--default-schema", "interaction", "--include-pattern", "interaction.*", "--date-parser", "timestamp", "--out-file", generated, "--log-level", "error"];
  if (!process.argv.includes("--refresh-types")) codegen.push("--verify");
  run(process.execPath, codegen, env);
  // Refresh is setup, not source-bound final acceptance.
  const testedSource = workingTreeSourceSha256();
  if (!process.argv.includes("--refresh-types") && testedSource !== source) throw new Error("RATING_SOURCE_CHANGED_DURING_RUN");
  console.log("Temporary restricted PostgreSQL ready; running real Rating/crypto acceptance.");
  stage = "acceptance";
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/phase7/ratings.test.ts", "tests/phase7/ratings-postgres.test.ts", "tests/phase7/reactions.test.ts", "tests/phase7/reactions-postgres.test.ts",
    "--no-file-parallelism", "--reporter=json", "--outputFile=" + reportPath], env);
  const tests = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = tests.testResults.flatMap(s => s.assertionResults ?? []);
  if (!tests.success || tests.numFailedTestSuites || tests.numFailedTests || tests.numPendingTests || tests.numTodoTests ||
      tests.numPassedTests !== 33 || assertions.length !== 33 || tests.testResults.length !== 4 ||
      tests.testResults.some(s => s.status !== "passed") || assertions.some(a => a.status !== "passed")) throw new Error("RATING_ACCEPTANCE_INCOMPLETE");
  if (workingTreeSourceSha256() !== testedSource) throw new Error("RATING_SOURCE_CHANGED_DURING_RUN");
  result = { runId, sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(), sourceTreeSha256: testedSource, version,
    migration, migrationSha256: createHash("sha256").update(readFileSync(migration)).digest("hex"),
    migrations: migrations.map(name => ({ name, sha256: createHash("sha256").update(readFileSync("supabase/migrations/" + name)).digest("hex") })),
    tools: { node: process.versions.node, npm: (process.env.npm_config_user_agent ?? "").match(/npm\/([^\s]+)/)?.[1] ?? "unavailable" },
    assertions: assertions.map(a => ({ title: a.title, status: a.status })),
    required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests, failedSuites: tests.numFailedTestSuites },
    roles: ["rating_runtime", "reaction_runtime", "shipwithali_application", "shipwithali_worker", "anon", "authenticated"],
    reproduction: "npm run setup:validation; npm run validation:ready; npm run phase7:focus:ratings (PHASE7_POSTGRES_BIN selects installed PostgreSQL binaries)",
    scope: "Native disposable PostgreSQL cluster; all repository migrations through #191. Full Phase 3-6 upgrade qualification belongs to #208." };
} catch (error) {
  // No provider messages, connection strings, payloads or secret-bearing PostgreSQL logs.
  console.error(error instanceof Error && /^RATING_/.test(error.message) ? error.message : "RATING_VALIDATION_FAILED");
  console.error(JSON.stringify({ stage, code: typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unavailable" }));
  if (readFileSyncSafe(reportPath)) {
    const r = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const suite of r.testResults ?? []) console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status,
      assertions: (suite.assertionResults ?? []).map(a => ({ title: a.title, status: a.status })) }));
  }
  process.exitCode = 1;
} finally {
  if (connected) await client.end();
  try {
    if (started) run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(temp, { recursive: true, force: true }); cleanup = true;
  } catch { console.error("RATING_CLEANUP_FAILED"); process.exitCode = 1; }
  if (result && cleanup) {
    mkdirSync("evidence", { recursive: true });
    writeFileSync("evidence/phase7-ratings-191.json", JSON.stringify({ ...result, cleanup }, null, 2) + "\n");
    console.log(JSON.stringify({ required: result.required, cleanup }));
  }
}
function readFileSyncSafe(path) { try { return readFileSync(path, "utf8"); } catch { return null; } }
