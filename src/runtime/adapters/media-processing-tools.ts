import { execFile as nodeExecFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { open, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { err, ok, type Rejection, type Result } from "@shared/domain";
import type { PdfProcessorPort, TrustedByteScannerPort } from "../../modules/media/application/processing.js";

const execFile = promisify(nodeExecFile);
const MAX_BYTES = 20 * 1024 * 1024;
// Leave time for storage reads/seals and the database commit inside the 60s
// application attempt budget. The external-work ceiling is 50s:
// 2s scanner version + 2x14s scans + 14s PDF preflight/process/version work,
// plus two 3s Storage operations. The commit statement is capped at 3s,
// leaving 7s for cleanup and application overhead.
const SCAN_TIMEOUT_MS = 14_000;
const PROCESS_TIMEOUT_MS = 6_000;
const POLICY_VERSION = "pdf-active-content-deny-1";
const BOUNDED_PDF_IMAGE = "jbarlow83/ocrmypdf-alpine@sha256:7f4055a0db3f6301a6d58d9ed0302f96d90ec06c038b065c6197d4d22ceae71c";
const BOUNDED_SCANNER_IMAGE = "clamav/clamav@sha256:75fb5fd95fcbe1d7e6d240c369c1572b686ee2c95949d1042b5148de8eddebb4";
const PINNED_CLAMAV_VERSION = "ClamAV 1.4.3/27927/Sun Mar 1 07:24:39 2026";
function safeFailure(code: string): Result<never, Rejection> {
  return err({ kind: "temporarily_unavailable", code });
}

export function isPinnedClamAvVersion(version: string): boolean {
  return version.replace(/\s+/gu, " ").trim() === PINNED_CLAMAV_VERSION;
}

export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("MEDIA_PDF_OUTPUT_INVALID");
  const file = await open(path, "r");
  try {
    const initial = await file.stat();
    if (!initial.isFile() || !Number.isSafeInteger(initial.size) || initial.size > maxBytes) throw new Error("MEDIA_PDF_OUTPUT_INVALID");
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, initial.size + 1));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await file.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const final = await file.stat();
    if (offset > maxBytes || final.size > maxBytes || offset !== final.size) throw new Error("MEDIA_PDF_OUTPUT_INVALID");
    return Buffer.from(buffer.subarray(0, offset));
  } finally {
    await file.close();
  }
}

export async function assertBoundedFile(path: string, maxBytes: number): Promise<void> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > maxBytes) {
      throw new Error("MEDIA_PDF_OUTPUT_INVALID");
    }
  } finally {
    await file.close();
  }
}

export function stopActionWithinDeadline(stop: () => Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; resolve(false); }, timeoutMs);
    void stop().then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    }).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export function monitorBoundedChildOutput(executable: string, args: readonly string[], outputPath: string,
  limits: { readonly maxBytes: number; readonly timeoutMs: number }, stopExternal?: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(executable, [...args], { stdio: "ignore", windowsHide: true, detached: !windows });
    let failure: Error | undefined;
    let checking = false;
    let stopPromise: Promise<void> | undefined;
    const stopTree = (): Promise<void> => stopPromise ??= new Promise((finish) => {
      const stopExternalBounded = async (): Promise<boolean> => stopExternal === undefined || await stopActionWithinDeadline(stopExternal, 1_000);
      const stopChild = (): Promise<void> => new Promise((done) => {
      if (windows) {
        if (child.pid === undefined) return done();
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        const killerTimeout = setTimeout(() => { killer.kill(); child.kill(); done(); }, 500);
        killer.once("error", () => { clearTimeout(killerTimeout); child.kill(); done(); });
        killer.once("close", () => { clearTimeout(killerTimeout); done(); });
      } else {
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
        done();
      }
      });
      if (stopExternal === undefined) return void stopChild().finally(finish);
      void (async () => {
        const stoppedBefore = await stopExternalBounded();
        await stopChild();
        const stoppedAfter = await stopExternalBounded();
        if (!stoppedBefore || !stoppedAfter) failure = new Error("MEDIA_CONTAINER_CLEANUP_FAILED");
      })().finally(finish);
    });
    const timeout = setTimeout(() => {
      failure = new Error("MEDIA_PDF_PROCESSOR_UNAVAILABLE");
      void stopTree();
    }, limits.timeoutMs);
    const monitor = setInterval(() => {
      if (checking || failure) return;
      checking = true;
      void stat(outputPath).then((info) => {
        if (info.size > limits.maxBytes) {
          failure = new Error("MEDIA_PDF_OUTPUT_INVALID");
          void stopTree();
        }
      }).catch(() => undefined).finally(() => { checking = false; });
    }, 10);
    child.once("error", (cause) => {
      failure ??= cause instanceof Error ? cause : new Error("MEDIA_PDF_PROCESSOR_UNAVAILABLE");
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearInterval(monitor);
      void (async () => {
        try {
          const info = await stat(outputPath);
          if (info.size > limits.maxBytes) failure = new Error("MEDIA_PDF_OUTPUT_INVALID");
        } catch { /* The caller validates expected output existence. */ }
        if (failure) {
          await stopTree();
          reject(failure);
        }
        else if (code === 0) resolve();
        else reject(Object.assign(new Error("MEDIA_PDF_PROCESSOR_UNAVAILABLE"), { code: code ?? signal }));
      })();
    });
  });
}

async function stopDockerContainer(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await new Promise<number | null>((resolve) => {
      const remover = spawn("docker", ["rm", "--force", containerName], { stdio: "ignore", windowsHide: true });
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(code);
      };
      const timeout = setTimeout(() => {
        remover.kill();
        if (process.platform === "win32" && remover.pid !== undefined) {
          const killer = spawn("taskkill", ["/pid", String(remover.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
          setTimeout(() => killer.kill(), 200);
        }
        finish(null);
      }, 300);
      remover.once("error", () => finish(null));
      remover.once("close", (code) => finish(code));
    });
    if (result === 0) return;
    try {
      await execFile("docker", ["container", "inspect", containerName], { timeout: 500, maxBuffer: 1024, windowsHide: true });
    } catch (cause) {
      const stderr = typeof cause === "object" && cause !== null && "stderr" in cause ? String((cause as { stderr: unknown }).stderr) : "";
      if (/no such (?:object|container)/iu.test(stderr)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("MEDIA_CONTAINER_CLEANUP_FAILED");
}

function dockerBoundedCommand(executable: string, args: readonly string[], outputPath: string,
  limits: { readonly maxBytes: number }): { executable: string; args: string[]; stop: () => Promise<void> } {
  const directory = dirname(outputPath);
  const mountSource = directory.replace(/\\/gu, "/");
  const containerName = `portfolio-pdf-${randomUUID()}`;
  const translatedArgs = args.map((argument) => {
    for (const prefix of [directory, mountSource]) {
      if (argument === prefix) return "/work";
      if (argument.startsWith(`${prefix}\\`) || argument.startsWith(`${prefix}/`)) {
        return `/work/${argument.slice(prefix.length).replace(/^[\\/]+/u, "").replace(/[\\/]+/gu, "/")}`;
      }
    }
    return argument;
  });
  const command = [
    "run", "--rm", "--pull=never", "--name", containerName, "--network=none", "--read-only", "--memory=1g", "--cpus=1", "--pids-limit=64",
    `--ulimit=fsize=${limits.maxBytes}:${limits.maxBytes}`, "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--mount", `type=bind,source=${mountSource},target=/work`, "--workdir", "/work", "--entrypoint", executable,
    BOUNDED_PDF_IMAGE, ...translatedArgs,
  ];
  return { executable: "docker", args: command, stop: () => stopDockerContainer(containerName) };
}

/** Uses the pinned processor container and Docker hard limits on every supported host. */
export function runWithBoundedOutput(executable: string, args: readonly string[], outputPath: string,
  limits: { readonly maxBytes: number; readonly timeoutMs: number; readonly python: string }): Promise<void> {
  const command = dockerBoundedCommand(executable, args, outputPath, limits);
  return monitorBoundedChildOutput(command.executable, command.args, outputPath, limits, command.stop);
}

async function toolVersion(executable: string, args: readonly string[]): Promise<string> {
  const scanner = executable === "clamscan";
  const image = scanner ? BOUNDED_SCANNER_IMAGE : BOUNDED_PDF_IMAGE;
  const entrypoint = scanner ? "clamscan" : executable;
  const containerName = `portfolio-version-${randomUUID()}`;
  let result: Awaited<ReturnType<typeof execFile>>;
  try {
    result = await execFile("docker", ["run", "--rm", "--pull=never", "--name", containerName, "--network=none", "--read-only", "--memory=512m", "--cpus=1", "--pids-limit=32",
      "--ulimit=fsize=4096:4096", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m", "--entrypoint", entrypoint, image, ...args],
    { encoding: "utf8", timeout: 2_000, maxBuffer: 4 * 1024, windowsHide: true });
  } catch (cause) {
    try { await stopDockerContainer(containerName); }
    catch { throw new Error("MEDIA_CONTAINER_CLEANUP_FAILED"); }
    throw cause;
  }
  const version = `${result.stdout.toString().trim()} ${result.stderr.toString().trim()}`.trim().replace(/[^A-Za-z0-9./_: -]/gu, "").slice(0, 150);
  if (version.length < 3) throw new Error("MEDIA_TOOL_VERSION_UNAVAILABLE");
  return version;
}

async function withTempPdf<T>(bytes: Uint8Array, action: (directory: string, input: string) => Promise<T>): Promise<T> {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) throw new Error("MEDIA_BYTES_OUT_OF_BOUNDS");
  const directory = await mkdtemp(join(tmpdir(), "portfolio-media-"));
  const input = join(directory, "candidate.pdf");
  try {
    await writeFile(input, bytes, { flag: "wx", mode: 0o600 });
    return await action(directory, input);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Runs the pinned ClamAV binary; exit 0 is clean, 1 is an unsafe signature. */
export function createClamAvScanner(options: { readonly executable?: string } = {}): TrustedByteScannerPort {
  const executable = options.executable ?? "clamscan";
  let versionPromise: Promise<string> | undefined;
  const version = () => versionPromise ??= toolVersion(executable, ["--version"]).catch((error: unknown) => { versionPromise = undefined; throw error; });
  return {
    async scan(bytes) {
      try {
        if (executable !== "clamscan") return safeFailure("MEDIA_SCANNER_UNAVAILABLE");
        const scannerVersion = await version();
        if (!isPinnedClamAvVersion(scannerVersion)) return safeFailure("MEDIA_SCANNER_UNAVAILABLE");
        const verdict = await withTempPdf(bytes, async (directory, input) => {
          try {
            const mountSource = directory.replace(/\\/gu, "/");
            const containerName = `portfolio-clamav-${randomUUID()}`;
            const dockerArgs = ["run", "--rm", "--pull=never", "--name", containerName, "--network=none", "--read-only", "--memory=2g", "--cpus=1", "--pids-limit=32",
              "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m", "--mount", `type=bind,source=${mountSource},target=/work,readonly`,
              "--workdir", "/work", "--entrypoint", "clamscan", BOUNDED_SCANNER_IMAGE, "--no-summary", "--stdout", "/work/candidate.pdf"];
            await monitorBoundedChildOutput("docker", dockerArgs, input,
              { maxBytes: MAX_BYTES, timeoutMs: SCAN_TIMEOUT_MS }, () => stopDockerContainer(containerName));
            return "clean" as const;
          } catch (cause) {
            const code = typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code: unknown }).code) : "";
            if (code === "1") return "unsafe" as const;
            throw new Error("MEDIA_SCANNER_UNAVAILABLE");
          }
        });
        return ok({ verdict, version: scannerVersion });
      } catch {
        return safeFailure("MEDIA_SCANNER_UNAVAILABLE");
      }
    },
  };
}

const PDF_PREFLIGHT = String.raw`
import sys, pikepdf
src, dst = sys.argv[1], sys.argv[2]
try:
    opened = pikepdf.open(src)
except Exception:
    raise SystemExit(21)
with opened as pdf:
    root = pdf.Root
    if pdf.is_encrypted or len(pdf.pages) < 1 or len(pdf.pages) > 500 or len(pdf.objects) > 100000:
        raise SystemExit(21)
    forbidden = {"/OpenAction", "/AA", "/AcroForm", "/Collection"}
    if any(key in root for key in forbidden):
        raise SystemExit(22)
    names = root.get("/Names", None)
    if names is not None and any(key in names for key in ("/JavaScript", "/EmbeddedFiles")):
        raise SystemExit(23)
    active = {"/JavaScript", "/Launch", "/GoToR", "/SubmitForm", "/ImportData", "/RichMedia", "/Movie", "/Sound"}
    for obj in pdf.objects:
        if "/S" in obj and str(obj["/S"]) in active:
            raise SystemExit(24)
        if "/OpenAction" in obj or "/AA" in obj:
            raise SystemExit(25)
    pdf.save(dst, compress_streams=True)
`;

/** Structural PDF validation plus OCRmyPDF's bounded parse/rewrite to PDF/A. */
export function createOcrMyPdfProcessor(options: { readonly python?: string; readonly ocrmypdf?: string } = {}): PdfProcessorPort {
  const python = options.python ?? "python3";
  const ocrmypdf = options.ocrmypdf ?? "ocrmypdf";
  return {
    async process(bytes) {
      try {
        if (python !== "python3" || ocrmypdf !== "ocrmypdf") return safeFailure("MEDIA_PDF_PROCESSOR_UNAVAILABLE");
        const version = await toolVersion(ocrmypdf, ["--version"]);
        const pikepdfVersion = await toolVersion(python, ["-c", "import pikepdf; print(pikepdf.__version__)"]);
        const processed = await withTempPdf(bytes, async (directory, input) => {
          const checked = join(directory, "checked.pdf");
          const output = join(directory, "processed.pdf");
          try {
            await runWithBoundedOutput(python, ["-c", PDF_PREFLIGHT, input, checked], checked, { maxBytes: MAX_BYTES, timeoutMs: 2_000, python });
          } catch (cause) {
            const exitCode = typeof cause === "object" && cause !== null && "code" in cause ? Number((cause as { code: unknown }).code) : 0;
            if ([21, 22, 23, 24, 25].includes(exitCode)) return { unsafe: true as const };
            throw new Error("MEDIA_PDF_PROCESSOR_UNAVAILABLE");
          }
          await assertBoundedFile(checked, MAX_BYTES);
          await runWithBoundedOutput(ocrmypdf, ["--skip-text", "--output-type", "pdfa-2", "--optimize", "0", "--jobs", "1", "--quiet", checked, output],
            output, { maxBytes: MAX_BYTES, timeoutMs: PROCESS_TIMEOUT_MS, python });
          await assertBoundedFile(output, MAX_BYTES);
          const verifiedOutput = join(directory, "verified-output.pdf");
          try { await runWithBoundedOutput(python, ["-c", PDF_PREFLIGHT, output, verifiedOutput], verifiedOutput, { maxBytes: MAX_BYTES, timeoutMs: 2_000, python }); }
          catch { throw new Error("MEDIA_PDF_OUTPUT_INVALID"); }
          const result = await readBoundedFile(verifiedOutput, MAX_BYTES);
          if (result.byteLength < 1 || !result.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("MEDIA_PDF_OUTPUT_INVALID");
          return { bytes: new Uint8Array(result), unsafe: false as const };
        });
        if (processed.unsafe) return err({ kind: "validation", code: "MEDIA_PDF_POLICY_REJECTED" });
        return ok({ bytes: processed.bytes, version: `${version};pikepdf-${pikepdfVersion}`.slice(0, 150), policyVersion: POLICY_VERSION });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "";
        if (message === "MEDIA_BYTES_OUT_OF_BOUNDS") return err({ kind: "validation", code: message });
        if (message === "MEDIA_PDF_OUTPUT_INVALID") return err({ kind: "validation", code: message });
        return safeFailure("MEDIA_PDF_PROCESSOR_UNAVAILABLE");
      }
    },
  };
}
