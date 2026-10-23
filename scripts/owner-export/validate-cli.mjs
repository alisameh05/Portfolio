import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_OWNER_EXPORT_ARCHIVE_BYTES, validateOwnerExportZip } from "./validator.mjs";

function readBoundedArchive(path) {
  const descriptor = openSync(path, "r");
  try {
    const initialSize = fstatSync(descriptor).size;
    if (!Number.isSafeInteger(initialSize) || initialSize > MAX_OWNER_EXPORT_ARCHIVE_BYTES) {
      throw Object.assign(new Error("archive exceeds the validation size limit"), { code: "ARCHIVE_SIZE_LIMIT" });
    }
    if (!fstatSync(descriptor).isFile()) {
      throw Object.assign(new Error("archive path is not a regular file"), { code: "ARCHIVE_READ_FAILED" });
    }
    const bytes = Buffer.alloc(initialSize);
    let offset = 0;
    while (offset < initialSize) {
      const count = readSync(descriptor, bytes, offset, initialSize - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== initialSize) {
      throw Object.assign(new Error("archive changed while being read"), { code: "ARCHIVE_READ_FAILED" });
    }
    if (fstatSync(descriptor).size !== initialSize) {
      throw Object.assign(new Error("archive changed while being read"), { code: "ARCHIVE_SIZE_LIMIT" });
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

const [archivePath, ...extraArguments] = process.argv.slice(2);
if (archivePath === undefined || extraArguments.length !== 0) {
  process.stderr.write("usage: npm run owner-export:validate -- <archive.zip>\n");
  process.exitCode = 2;
} else {
  try {
    const result = validateOwnerExportZip(readBoundedArchive(resolve(archivePath)));
    process.stdout.write(`${JSON.stringify({
      valid: true,
      schemaVersion: result.manifest.schemaVersion,
      includedScopes: result.includedScopes,
      recordCounts: result.recordCounts,
      verifiedSchemaCount: result.verifiedSchemaCount,
      verifiedAssetCount: result.verifiedAssetCount,
      dependencyCount: result.dependencyCount,
      archiveDigest: result.archiveDigest,
    }, null, 2)}\n`);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "ARCHIVE_READ_FAILED";
    process.stderr.write(`Owner export validation failed: ${code}\n`);
    process.exitCode = 1;
  }
}
