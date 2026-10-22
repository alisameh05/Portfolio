import { readFileSync } from "node:fs";

export function readOptionalGitAlternates(path, read = readFileSync) {
  try {
    return read(path, "utf8").split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean) ?? "";
  } catch (error) {
    // Ordinary clones, including Actions checkouts, have no alternates file.
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}
