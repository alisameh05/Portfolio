import { createHash } from "node:crypto";

export function migrationSha256(contents) {
  return createHash("sha256")
    .update(contents.replaceAll("\r\n", "\n"), "utf8")
    .digest("hex");
}
