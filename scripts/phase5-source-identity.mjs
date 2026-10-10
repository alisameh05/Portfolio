import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function workingTreeSourceSha256() {
  const digest = createHash("sha256").update(git(["diff", "origin/master", "--binary", "--", ".", ":(exclude)evidence/**"]));
  const untracked = git(["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/u)
    .filter((path) => path !== "" && !path.replaceAll("\\", "/").startsWith("evidence/"))
    .sort();
  for (const path of untracked) digest.update(path).update(readFileSync(join(ROOT, path)));
  return digest.digest("hex");
}
