import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function workingTreeSourceSha256() {
  // Fingerprint the actual source, independent of remote refs and staging.
  // NUL-delimited paths also support spaces and newlines in filenames.
  const paths = [...new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0").filter((path) => path !== "" && !path.startsWith("evidence/")))].sort();
  const digest = createHash("sha256").update("portfolio-source-files-v1\0");
  for (const path of paths) {
    const absolute = join(ROOT, path);
    // A tracked deletion and its staged equivalent describe the same tree.
    if (!existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    const contentHash = createHash("sha256").update(content).digest("hex");
    digest.update(JSON.stringify([path, stat.isSymbolicLink() ? "symlink" : "file", contentHash])).update("\0");
  }
  return digest.digest("hex");
}
