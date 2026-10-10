import { open, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertBoundedFile, monitorBoundedChildOutput, readBoundedFile, runWithBoundedOutput } from "../../src/runtime/adapters/media-processing-tools.js";

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
      await expect(assertBoundedFile(path, 8)).rejects.toThrow("MEDIA_PDF_OUTPUT_INVALID");
      await expect(readBoundedFile(path, 8)).rejects.toThrow("MEDIA_PDF_OUTPUT_INVALID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates a subprocess while its intermediate output crosses the cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-processing-tools-"));
    const path = join(directory, "growing.pdf");
    const writer = "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'w');for(let i=0;i<100;i++){fs.writeSync(fd,Buffer.alloc(2));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}fs.closeSync(fd)";
    try {
      await expect(monitorBoundedChildOutput(process.execPath, ["-e", writer, path], path, { maxBytes: 8, timeoutMs: 3_000 }))
        .rejects.toThrow("MEDIA_PDF_OUTPUT_INVALID");
      expect((await stat(path)).size).toBeLessThan(200);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses an inherited hard file-size limit or fails closed when the host lacks one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-processing-tools-"));
    const path = join(directory, "hard-limited.pdf");
    const writer = "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'w');fs.writeSync(fd,Buffer.alloc(2*1024*1024));fs.closeSync(fd)";
    try {
      if (process.platform === "win32") {
        await expect(runWithBoundedOutput(process.execPath, ["-e", writer, path], path,
          { maxBytes: 8, timeoutMs: 3_000, python: "python3" })).rejects.toThrow("MEDIA_PDF_PROCESSOR_UNAVAILABLE");
      } else {
        await expect(runWithBoundedOutput(process.execPath, ["-e", writer, path], path,
          { maxBytes: 8, timeoutMs: 3_000, python: "python3" })).rejects.toBeDefined();
        expect((await stat(path)).size).toBeLessThanOrEqual(8);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
