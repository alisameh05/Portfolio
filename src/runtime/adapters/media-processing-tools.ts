import { execFile as nodeExecFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { open, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { err, ok, type Rejection, type Result } from "@shared/domain";
import type { PdfProcessorPort, TrustedByteScannerPort, VideoProcessorPort } from "../../modules/media/application/processing.js";

const execFile = promisify(nodeExecFile);
const MAX_BYTES = 20 * 1024 * 1024;
// Leave time for storage reads/seals and the database commit inside the 60s
// application attempt budget. The external-work ceiling is 52s:
// 2s scanner version + 2x14s scans + 16s PDF preflight/process/version work,
// plus two 3s Storage operations. The commit statement is capped at 3s,
// leaving 5s for cleanup and application overhead.
const SCAN_TIMEOUT_MS = 14_000;
const PROCESS_TIMEOUT_MS = 8_000;
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
  limits: { readonly maxBytes: number; readonly image?: string }): { executable: string; args: string[]; stop: () => Promise<void> } {
  const directory = dirname(outputPath);
  const mountSource = directory.replace(/\\/gu, "/");
  const containerName = `portfolio-media-${randomUUID()}`;
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
    limits.image ?? BOUNDED_PDF_IMAGE, ...translatedArgs,
  ];
  return { executable: "docker", args: command, stop: () => stopDockerContainer(containerName) };
}

/** Uses the pinned processor container and Docker hard limits on every supported host. */
export function runWithBoundedOutput(executable: string, args: readonly string[], outputPath: string,
  limits: { readonly maxBytes: number; readonly timeoutMs: number; readonly python?: string; readonly image?: string }): Promise<void> {
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

async function withTempPdf<T>(bytes: Uint8Array, action: (directory: string, input: string) => Promise<T>, maxBytes = MAX_BYTES): Promise<T> {
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) throw new Error("MEDIA_BYTES_OUT_OF_BOUNDS");
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
export function createClamAvScanner(options: { readonly executable?: string; readonly maxBytes?: number; readonly timeoutMs?: number } = {}): TrustedByteScannerPort {
  const executable = options.executable ?? "clamscan";
  let versionPromise: Promise<string> | undefined;
  const version = () => versionPromise ??= toolVersion(executable, ["--version"]).catch((error: unknown) => { versionPromise = undefined; throw error; });
  return {
    async scan(bytes, scanOptions) {
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
              { maxBytes: options.maxBytes ?? MAX_BYTES, timeoutMs: Math.min(options.timeoutMs ?? SCAN_TIMEOUT_MS, scanOptions?.timeoutMs ?? SCAN_TIMEOUT_MS) }, () => stopDockerContainer(containerName));
            return "clean" as const;
          } catch (cause) {
            const code = typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code: unknown }).code) : "";
            if (code === "1") return "unsafe" as const;
            throw new Error("MEDIA_SCANNER_UNAVAILABLE");
          }
        }, options.maxBytes ?? MAX_BYTES);
        return ok({ verdict, version: scannerVersion });
      } catch {
        return safeFailure("MEDIA_SCANNER_UNAVAILABLE");
      }
    },
    async scanMany(inputs, scanOptions) {
      let version = "";
      for (const input of inputs) {
        const result = await this.scan(input, scanOptions);
        if (!result.ok) return result;
        version = result.value.version;
        if (result.value.verdict !== "clean") return ok({ verdict: result.value.verdict, version });
      }
      return ok({ verdict: "clean" as const, version });
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

const VIDEO_IMAGE = "jrottenberg/ffmpeg:7.1-ubuntu2404";
const VIDEO_POLICY_VERSION = "mp4-webm-bounded-variants-1";
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const VIDEO_MAX_FRAMES = 1_800;
const VIDEO_MAX_DURATION_SECONDS = 60;
const VIDEO_PROCESS_TIMEOUT_MS = 8_000;

interface VideoProbe {
  readonly format?: { readonly format_name?: string; readonly duration?: string };
  readonly streams?: readonly { readonly codec_type?: string; readonly codec_name?: string; readonly width?: number; readonly height?: number;
    readonly avg_frame_rate?: string; readonly nb_read_frames?: string }[];
}

function rational(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  if (numerator === undefined || denominator === undefined || !Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return numerator / denominator;
}

function readEbmlVint(bytes: Uint8Array, offset: number, elementId: boolean): { readonly length: number; readonly value: bigint } | undefined {
  if (offset >= bytes.byteLength) return undefined;
  const first = bytes[offset]!;
  let marker = 0x80;
  let length = 1;
  while (length <= 8 && (first & marker) === 0) { marker >>= 1; length += 1; }
  if (length > 8 || offset + length > bytes.byteLength || (elementId && length > 4)) return undefined;
  let value = BigInt(elementId ? first : first & (marker - 1));
  for (let index = 1; index < length; index += 1) value = value * 256n + BigInt(bytes[offset + index]!);
  return { length, value };
}

function isWebMContainer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 5 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) return false;
  const headerSize = readEbmlVint(bytes, 4, false);
  if (!headerSize) return false;
  const unknownSize = (1n << BigInt(7 * headerSize.length)) - 1n;
  const headerStart = 4 + headerSize.length;
  const headerEndBig = BigInt(headerStart) + headerSize.value;
  if (headerSize.value === unknownSize || headerSize.value > 1024n || headerEndBig > BigInt(bytes.byteLength)) return false;
  const headerEnd = Number(headerEndBig);
  let offset = headerStart;
  while (offset < headerEnd) {
    const id = readEbmlVint(bytes, offset, true);
    if (!id) return false;
    offset += id.length;
    const size = readEbmlVint(bytes, offset, false);
    if (!size) return false;
    offset += size.length;
    const end = BigInt(offset) + size.value;
    if (size.value === (1n << BigInt(7 * size.length)) - 1n || end > BigInt(headerEnd)) return false;
    if (id.value === 0x4282n) return size.value === 4n && Buffer.from(bytes.subarray(offset, Number(end))).toString("ascii") === "webm";
    offset = Number(end);
  }
  return false;
}

const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VH", "M4VP", "dash"]);

function isMp4Container(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16 || Buffer.from(bytes.subarray(4, 8)).toString("ascii") !== "ftyp") return false;
  const boxSize = Buffer.from(bytes.subarray(0, 4)).readUInt32BE(0);
  if (boxSize < 16 || boxSize > 4_096 || boxSize > bytes.byteLength || boxSize % 4 !== 0) return false;
  const majorBrand = Buffer.from(bytes.subarray(8, 12)).toString("ascii");
  return MP4_BRANDS.has(majorBrand);
}

async function runVideoTool(executable: string, args: readonly string[], directory: string, timeoutMs: number): Promise<string> {
  const mountSource = directory.replace(/\\/gu, "/");
  const containerName = `portfolio-video-${randomUUID()}`;
  const translated = args.map((argument) => argument.startsWith(`${directory}${process.platform === "win32" ? "\\" : "/"}`)
    ? `/work/${argument.slice(directory.length).replace(/^[\\/]+/u, "").replace(/[\\/]+/gu, "/")}` : argument);
  try {
    const result = await execFile("docker", ["run", "--rm", "--pull=never", "--name", containerName, "--network=none", "--read-only",
      "--memory=1g", "--cpus=1", "--pids-limit=64", "--ulimit=fsize=52428800:52428800", "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
      "--mount", `type=bind,source=${mountSource},target=/work`, "--workdir", "/work", "--entrypoint", executable, VIDEO_IMAGE, ...translated],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 128 * 1024, windowsHide: true });
    return result.stdout.toString();
  } catch (cause) {
    try { await stopDockerContainer(containerName); } catch { throw new Error("MEDIA_CONTAINER_CLEANUP_FAILED"); }
    const code = typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code: unknown }).code) : "";
    if (code === "ETIMEDOUT") throw new Error("MEDIA_VIDEO_PROCESSOR_TIMEOUT");
    throw new Error("MEDIA_VIDEO_PROCESSOR_UNAVAILABLE");
  }
}

async function probeVideo(path: string, directory: string): Promise<VideoProbe> {
  const output = await runVideoTool("ffprobe", ["-v", "error", "-err_detect", "explode", "-read_intervals", "%+61", "-count_frames", "-select_streams", "v:0", "-show_entries",
    "format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_read_frames", "-of", "json", path], directory, 3_000);
  try { return JSON.parse(output) as VideoProbe; } catch { throw new Error("MEDIA_VIDEO_INPUT_INVALID"); }
}

/** Detects actual MP4/WebM structure, bounds decoded work, transcodes one normalized private variant, then re-probes it. */
export function createFfmpegVideoProcessor(): VideoProcessorPort {
  let versionPromise: Promise<string> | undefined;
  const version = () => versionPromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "portfolio-video-version-"));
    try { return await runVideoTool("ffmpeg", ["-version"], directory, 2_000); }
    finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  })().then((value) => {
      const firstLine = value.split(/\r?\n/u, 1)[0] ?? "";
      if (!/^ffmpeg version 7\.1(?:\s|$)/u.test(firstLine)) throw new Error("MEDIA_VIDEO_PROCESSOR_UNAVAILABLE");
      return firstLine.replace(/[^A-Za-z0-9./_: -]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 150);
    }).catch((error: unknown) => { versionPromise = undefined; throw error; });
  return {
    async process(bytes) {
      if (bytes.byteLength < 12 || bytes.byteLength > VIDEO_MAX_BYTES) return err({ kind: "validation", code: "MEDIA_BYTES_OUT_OF_BOUNDS" });
      const detectedMimeType = isWebMContainer(bytes) ? "video/webm"
        : isMp4Container(bytes) ? "video/mp4" : undefined;
      if (!detectedMimeType) return err({ kind: "validation", code: "MEDIA_VIDEO_INPUT_INVALID" });
      try {
        const processorVersion = await version();
        const directory = await mkdtemp(join(tmpdir(), "portfolio-video-"));
        const input = join(directory, detectedMimeType === "video/mp4" ? "candidate.mp4" : "candidate.webm");
        const output = join(directory, detectedMimeType === "video/mp4" ? "normalized.mp4" : "normalized.webm");
        try {
          await writeFile(input, bytes, { flag: "wx", mode: 0o600 });
          const source = await probeVideo(input, directory);
          const format = source.format?.format_name ?? "";
          const stream = source.streams?.[0];
          const duration = Number(source.format?.duration);
          const frameRate = rational(stream?.avg_frame_rate);
          const frames = Number(stream?.nb_read_frames);
          const expectedFormat = detectedMimeType === "video/mp4" ? isMp4Container(bytes) && /(?:^|,)mov(?:,|$)/u.test(format) : isWebMContainer(bytes);
          const supportedCodec = detectedMimeType === "video/mp4" ? stream?.codec_name === "h264" : ["vp8", "vp9"].includes(stream?.codec_name ?? "");
          if (!expectedFormat || !stream || stream.codec_type !== "video" || !supportedCodec ||
              !Number.isFinite(duration) || duration <= 0 || duration > VIDEO_MAX_DURATION_SECONDS ||
              !Number.isSafeInteger(frames) || frames < 1 || frames > VIDEO_MAX_FRAMES ||
              !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height) || stream.width! < 1 || stream.width! > 1920 || stream.height! < 1 || stream.height! > 1080 ||
              !Number.isFinite(frameRate) || frameRate! <= 0 || frameRate! > 30) {
            return err({ kind: "validation", code: "MEDIA_VIDEO_INPUT_UNSUPPORTED" });
          }
          const videoArgs = detectedMimeType === "video/mp4"
            ? ["-nostdin", "-v", "error", "-xerror", "-err_detect", "explode", "-i", input, "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", String(VIDEO_MAX_FRAMES),
              "-t", String(VIDEO_MAX_DURATION_SECONDS), "-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
              "-threads", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", "-y", output]
            : ["-nostdin", "-v", "error", "-xerror", "-err_detect", "explode", "-i", input, "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", String(VIDEO_MAX_FRAMES),
              "-t", String(VIDEO_MAX_DURATION_SECONDS), "-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
              "-threads", "1", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "0", "-crf", "40", "-f", "webm", "-y", output];
          const limits = { maxBytes: VIDEO_MAX_BYTES, timeoutMs: VIDEO_PROCESS_TIMEOUT_MS, image: VIDEO_IMAGE };
          const command = dockerBoundedCommand("ffmpeg", videoArgs, output, limits);
          await monitorBoundedChildOutput(command.executable, command.args, output, limits, command.stop);
          const outputStat = await assertBoundedFile(output, VIDEO_MAX_BYTES);
          void outputStat;
          const outputBytes = await readBoundedFile(output, VIDEO_MAX_BYTES);
          const outputProbe = await probeVideo(output, directory);
          const outputStream = outputProbe.streams?.[0];
          const outputFormat = outputProbe.format?.format_name ?? "";
          const outputCodec = outputStream?.codec_name ?? "";
          const expectedOutputCodec = detectedMimeType === "video/mp4" ? "h264" : "vp9";
          const outputWidth = outputStream?.width, outputHeight = outputStream?.height;
          const outputFrames = Number(outputStream?.nb_read_frames), outputDuration = Number(outputProbe.format?.duration);
          if (!(detectedMimeType === "video/mp4" ? isMp4Container(outputBytes) && /(?:^|,)mov(?:,|$)/u.test(outputFormat) : isWebMContainer(outputBytes)) ||
              outputStream?.codec_type !== "video" || outputCodec !== expectedOutputCodec || !Number.isSafeInteger(outputWidth) || !Number.isSafeInteger(outputHeight) ||
              outputWidth! < 1 || outputWidth! > 1280 || outputHeight! < 1 || outputHeight! > 720 || !Number.isSafeInteger(outputFrames) || outputFrames < 1 || outputFrames > VIDEO_MAX_FRAMES ||
              !Number.isFinite(outputDuration) || outputDuration <= 0 || outputDuration > VIDEO_MAX_DURATION_SECONDS ||
              outputFrames !== frames || Math.abs(outputDuration - duration) > 0.1) {
            return err({ kind: "validation", code: "MEDIA_VIDEO_OUTPUT_INVALID" });
          }
          return ok({ detectedMimeType, variants: [{ variantName: "normalized", mimeType: detectedMimeType, bytes: new Uint8Array(outputBytes),
            width: outputWidth!, height: outputHeight!, codec: outputCodec }], version: processorVersion, policyVersion: VIDEO_POLICY_VERSION });
        } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : "";
        if (code === "MEDIA_VIDEO_PROCESSOR_TIMEOUT") return safeFailure("MEDIA_PROCESSING_TIMEOUT");
        if (code === "MEDIA_VIDEO_INPUT_INVALID" || code === "MEDIA_VIDEO_OUTPUT_INVALID") return err({ kind: "validation", code });
        return safeFailure("MEDIA_PROCESSOR_UNAVAILABLE");
      }
    },
  };
}
