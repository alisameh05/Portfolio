import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { open, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Rejection, type Result } from "@shared/domain";
import type { PdfProcessorPort, TrustedByteScannerPort } from "../../modules/media/application/processing.js";

const execFile = promisify(nodeExecFile);
const MAX_BYTES = 20 * 1024 * 1024;
const SCAN_TIMEOUT_MS = 8_000;
const PROCESS_TIMEOUT_MS = 8_000;
const POLICY_VERSION = "pdf-active-content-deny-1";
const PINNED_CLAMAV_VERSION = /^ClamAV 1\.4\.3\/[0-9]+\//u;
function safeFailure(code: string): Result<never, Rejection> {
  return err({ kind: "temporarily_unavailable", code });
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

async function toolVersion(executable: string, args: readonly string[]): Promise<string> {
  const result = await execFile(executable, [...args], { timeout: 2_000, maxBuffer: 4 * 1024, windowsHide: true });
  const version = `${result.stdout.trim()} ${result.stderr.trim()}`.trim().replace(/[^A-Za-z0-9./_ -]/gu, "").slice(0, 150);
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
        const scannerVersion = await version();
        if (!PINNED_CLAMAV_VERSION.test(scannerVersion)) return safeFailure("MEDIA_SCANNER_UNAVAILABLE");
        const verdict = await withTempPdf(bytes, async (_directory, input) => {
          try {
            await execFile(executable, ["--no-summary", "--stdout", input], { timeout: SCAN_TIMEOUT_MS, maxBuffer: 16 * 1024, windowsHide: true });
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
        const version = await toolVersion(ocrmypdf, ["--version"]);
        const pikepdfVersion = await toolVersion(python, ["-c", "import pikepdf; print(pikepdf.__version__)"]);
        const processed = await withTempPdf(bytes, async (directory, input) => {
          const checked = join(directory, "checked.pdf");
          const output = join(directory, "processed.pdf");
          try {
            await execFile(python, ["-c", PDF_PREFLIGHT, input, checked], { timeout: 4_000, maxBuffer: 16 * 1024, windowsHide: true });
          } catch (cause) {
            const exitCode = typeof cause === "object" && cause !== null && "code" in cause ? Number((cause as { code: unknown }).code) : 0;
            if ([21, 22, 23, 24, 25].includes(exitCode)) return { unsafe: true as const };
            throw new Error("MEDIA_PDF_PROCESSOR_UNAVAILABLE");
          }
          await execFile(ocrmypdf, ["--skip-text", "--output-type", "pdfa-2", "--optimize", "0", "--jobs", "1", "--quiet", checked, output], {
            timeout: PROCESS_TIMEOUT_MS, maxBuffer: 16 * 1024, windowsHide: true,
          });
          const verifiedOutput = join(directory, "verified-output.pdf");
          try { await execFile(python, ["-c", PDF_PREFLIGHT, output, verifiedOutput], { timeout: 4_000, maxBuffer: 16 * 1024, windowsHide: true }); }
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
