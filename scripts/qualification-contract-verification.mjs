import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createQualificationPrerequisiteCache } from "./qualification-prerequisite-cache.mjs";
import { currentRuntimeIdentity } from "./qualification-context.mjs";
import { executeQualificationCommand } from "./qualification-command.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { redactSafeDetail } from "./validation-errors.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// Preserve the three constituents of contract:verify, but share their actual
// primitive executions with earlier phase checks instead of caching an opaque
// compound command that would run drift/compatibility a second time.
export async function verifyQualificationContracts({ root = ROOT, cache, environment = process.env,
  execute = executeQualificationCommand, log = (value) => process.stdout.write(value) } = {}) {
  const npm = environment.npm_execpath
    ? { entry: process.execPath, args: [environment.npm_execpath, "run", "contract:generate"] }
    : { entry: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "contract:generate"], shell: process.platform === "win32" };
  const commands = [
    { script: "contract:generate", command: npm },
    ...["check-contract-drift", "check-contract-compatibility"].map((name) => ({
      script: `direct:${name}.mjs`, command: { entry: process.execPath, args: [join(root, `scripts/${name}.mjs`)] },
    })),
  ];
  const results = [];
  for (const { script, command } of commands) {
    const result = await cache.runAsync({ script, args: [], environment,
      entry: JSON.stringify({ entry: command.entry, args: command.args }),
      invoke: () => execute({ ...command, cwd: root, environment }),
      // The normal commands redact their own output; cache persistent output
      // still scrubs known secret environment values without removing newlines.
      sanitizeOutput: (output) => {
        let safe = String(output ?? "");
        for (const [name, value] of Object.entries(environment)) {
          if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SERVICE_ROLE_KEY)/iu.test(name) && value.length >= 6) safe = safe.replaceAll(value, "[redacted]");
        }
        return safe;
      },
    });
    log(`${result.output}\n[qualification prerequisite ${script}: ${result.reused ? "reused" : "executed"}]\n`);
    results.push({ script, ...result });
    if (result.status !== 0 || result.errorCode !== null || result.skipped !== 0 || result.timedOut) return { status: 1, results };
  }
  return { status: 0, results };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/qualification-contract-verification.mjs")) {
  try {
    const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const cache = createQualificationPrerequisiteCache({ root: ROOT, sourceRevision,
      sourceTreeSha256: workingTreeSourceSha256(), runtime: currentRuntimeIdentity(), environment: process.env });
    process.exitCode = (await verifyQualificationContracts({ cache })).status;
  } catch (error) { console.error(`QUALIFICATION_CONTRACT_VERIFICATION_FAILED:${redactSafeDetail(error.message)}`); process.exitCode = 1; }
}
