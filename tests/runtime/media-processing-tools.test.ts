import { open, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBoundedFile } from "../../src/runtime/adapters/media-processing-tools.js";

describe("bounded PDF output reads", () => {
  it("reads a complete output under the configured byte limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-processing-tools-"));
    const path = join(directory, "verified.pdf");
    try {
      await writeFile(path, "%PDF-test");
      await expect(readBoundedFile(path, 32)).resolves.toEqual(Buffer.from("%PDF-test"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized sparse output without allocating its full size", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-processing-tools-"));
    const path = join(directory, "oversized.pdf");
    try {
      const file = await open(path, "wx");
      try { await file.truncate(64 * 1024 * 1024); } finally { await file.close(); }
      await expect(readBoundedFile(path, 8)).rejects.toThrow("MEDIA_PDF_OUTPUT_INVALID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
