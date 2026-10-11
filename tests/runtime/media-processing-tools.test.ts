import { open, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertBoundedFile, createClamAvScanner, isPinnedClamAvVersion, monitorBoundedChildOutput, readBoundedFile, runWithBoundedOutput, stopActionWithinDeadline } from "../../src/runtime/adapters/media-processing-tools.js";

describe("bounded PDF output reads", () => {
  it("accepts only the recorded ClamAV runtime and definition version", () => {
    expect(isPinnedClamAvVersion("ClamAV 1.4.3/27927/Sun Mar 1 07:24:39 2026")).toBe(true);
    expect(isPinnedClamAvVersion("ClamAV 1.4.3/27927/Sun Mar  1 07:24:39 2026")).toBe(true);
    expect(isPinnedClamAvVersion("ClamAV 1.4.3/27928/Mon Mar 2 07:24:39 2026")).toBe(false);
    expect(isPinnedClamAvVersion("ClamAV 1.5.0/27927/Sun Mar 1 07:24:39 2026")).toBe(false);
  });

  it("rejects an executable override so the checked and used scanner cannot differ", async () => {
    const result = await createClamAvScanner({ executable: "C:\\tools\\clamscan.exe" }).scan(Buffer.from("%PDF-test"));
    expect(result).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_SCANNER_UNAVAILABLE" } });
  });

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
      const finalSize = (await stat(path)).size;
      // OS scheduling changes the final write count; assert the watcher observed a cap crossing and stopped before all 200 bytes.
      expect(finalSize).toBeGreaterThan(8);
      expect(finalSize).toBeLessThan(200);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("stops helper processes before rejecting a timed out or oversized worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-processing-tools-tree-"));
    const path = join(directory, "growing.pdf");
    const pidPath = join(directory, "child.pid");
    const childCode = "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'w');setInterval(()=>fs.writeSync(fd,Buffer.alloc(2)),10)";
    const parentCode = "const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'ignore'});fs.writeFileSync(process.argv[3],String(child.pid));setInterval(()=>{},1000)";
    try {
      await expect(monitorBoundedChildOutput(process.execPath, ["-e", parentCode, childCode, path, pidPath], path,
        { maxBytes: 8, timeoutMs: 3_000 })).rejects.toThrow("MEDIA_PDF_OUTPUT_INVALID");
      const sizeAfterStop = (await stat(path)).size;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await stat(path)).size).toBe(sizeAfterStop);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not wait indefinitely for external process-tree cleanup", async () => {
    const startedAt = Date.now();
    await expect(stopActionWithinDeadline(() => new Promise<void>(() => undefined), 100)).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("reports container cleanup failures instead of treating them as success", async () => {
    await expect(stopActionWithinDeadline(async () => { throw new Error("docker rm failed"); }, 100)).resolves.toBe(false);
  });

  it("uses an inherited hard file-size limit or fails closed when the host lacks one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-processing-tools-"));
    const path = join(directory, "hard-limited.pdf");
    const writer = "import sys; open(sys.argv[1], 'wb').write(b'x' * (2 * 1024 * 1024))";
    try {
      if (process.platform === "win32") {
        const limited = runWithBoundedOutput("python3", ["-c", "import sys; open(sys.argv[1], 'wb').write(b'x' * (2 * 1024 * 1024))", path], path,
          { maxBytes: 8, timeoutMs: 3_000, python: "python3" });
        if (process.env["PHASE6_PDF_PROCESSOR_IMAGE"] === "jbarlow83/ocrmypdf-alpine@sha256:7f4055a0db3f6301a6d58d9ed0302f96d90ec06c038b065c6197d4d22ceae71c") {
          await expect(limited).rejects.toBeDefined();
          expect((await stat(path)).size).toBeLessThanOrEqual(8);
        } else {
          await expect(limited).rejects.toThrow(/MEDIA_PDF_PROCESSOR_UNAVAILABLE|spawn docker/iu);
        }
      } else {
        await expect(runWithBoundedOutput("python3", ["-c", writer, path], path,
          { maxBytes: 8, timeoutMs: 3_000, python: "python3" })).rejects.toBeDefined();
        expect((await stat(path)).size).toBeLessThanOrEqual(8);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
