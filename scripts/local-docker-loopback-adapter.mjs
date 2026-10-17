import { spawnSync } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isLocalValidationProjectId(value) {
  return /^shipwithali-(?:phase[36]-[a-f0-9]{16}|phase6-162-[a-f0-9]{12}|46-(?:clean|upgrade)-\d+|settings-(?:clean|upgrade)-[a-f0-9]{12})$/u.test(value);
}

// Docker's network default is not honored by every host configuration. Supply
// an explicit address only for the CLI's named, labeled disposable services.
export function localLoopbackDockerArguments(args, projectId) {
  if (!isLocalValidationProjectId(projectId)) throw new Error("LOCAL_DOCKER_PROJECT_SCOPE_INVALID");
  if (!["create", "run"].includes(args[0])) return args;
  const publishes = args.some(arg => arg === "-p" || arg === "--publish" || arg.startsWith("--publish=") || /^-p.+/u.test(arg));
  if (args.includes("-P") || args.includes("--publish-all")) throw new Error("LOCAL_DOCKER_UNBOUNDED_PUBLISH_DENIED");
  if (!publishes) return args;
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  const name = option("--name");
  const labels = args.flatMap((arg, index) => ["--label", "-l"].includes(arg) ? [args[index + 1]] :
    arg.startsWith("--label=") ? [arg.slice(8)] : []);
  if (!name?.startsWith("supabase_") || !name.endsWith(`_${projectId}`) ||
      !labels.includes(`com.supabase.cli.project=${projectId}`)) {
    throw new Error("LOCAL_DOCKER_PUBLISH_SCOPE_INVALID");
  }
  const bind = (value) => {
    const port = /^(?:(?:0\.0\.0\.0|127\.0\.0\.1):)?(\d+):(\d+(?:\/(?:tcp|udp))?)$/u.exec(value ?? "");
    if (!port) throw new Error("LOCAL_DOCKER_PUBLISH_FORMAT_INVALID");
    return `127.0.0.1:${port[1]}:${port[2]}`;
  };
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-p" || arg === "--publish") output.push(arg, bind(args[++index]));
    else if (arg.startsWith("--publish=")) output.push(`--publish=${bind(arg.slice(10))}`);
    else if (/^-p.+/u.test(arg)) output.push(`-p${bind(arg.slice(2))}`);
    else output.push(arg);
  }
  return output;
}

const executableShim = process.platform === "win32" && process.env.SHIPWITHALI_DOCKER_SHIM &&
  resolve(process.execPath) === resolve(process.env.SHIPWITHALI_DOCKER_SHIM);
if (executableShim || process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // Node resolves argv[1] as an entry path before its preload runs. The
    // pinned CLI invokes Docker with a command verb, so recover that basename.
    const invocation = executableShim ? [basename(process.argv[1] ?? ""), ...process.argv.slice(2)] : process.argv.slice(2);
    const args = localLoopbackDockerArguments(invocation, process.env.SHIPWITHALI_DOCKER_PROJECT);
    const command = process.env.SHIPWITHALI_REAL_DOCKER;
    if (!command || !isAbsolute(command) || !["docker", "docker.exe"].includes(basename(command).toLowerCase())) {
      throw new Error("LOCAL_DOCKER_EXECUTABLE_INVALID");
    }
    // Preserve the CLI's streams; never print its arguments or environment.
    const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
    if (executableShim) process.exit(result.status ?? 1);
    else process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(/^(?:LOCAL_DOCKER_)[A-Z_]+$/u.test(error?.message ?? "") ? error.message : "LOCAL_DOCKER_ADAPTER_FAILED");
    if (executableShim) process.exit(1);
    else process.exitCode = 1;
  }
}
