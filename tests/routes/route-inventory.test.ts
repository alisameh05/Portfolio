import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "check-route-inventory.mjs");
const REPORT = join(ROOT, "evidence", "phase-1-route-inventory.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

type Bundle = {
  paths: Record<string, Record<string, unknown>>;
};

function loadBundle(relativePath: string): Bundle {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8")) as Bundle;
}

function listOperations(bundle: Bundle): string[] {
  return Object.entries(bundle.paths)
    .flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) => HTTP_METHODS.has(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

function runInventory(extraArgs = ""): { ok: boolean; output: string } {
  try {
    const output = execSync(`node "${SCRIPT}" ${extraArgs}`, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (err: unknown) {
    const error = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = error.stdout?.toString() ?? "";
    const stderr = error.stderr?.toString() ?? "";
    return { ok: false, output: (stdout + stderr).trim() };
  }
}

describe("Phase 1 route and source inventory (#11)", () => {
  it("provides the executable inventory script", () => {
    expect(existsSync(SCRIPT), "scripts/check-route-inventory.mjs exists").toBe(true);
  });

  it("passes the inventory check with exit code 0", () => {
    const result = runInventory();
    expect(result.ok).toBe(true);
  });

  it("emits a deterministic evidence report", () => {
    const first = runInventory();
    expect(first.ok).toBe(true);
    const before = readFileSync(REPORT, "utf8");
    const second = runInventory();
    expect(second.ok).toBe(true);
    const after = readFileSync(REPORT, "utf8");
    expect(after).toBe(before);

    const report = JSON.parse(after) as {
      publicOperations: string[];
      ownerOperations: string[];
      runtimeRoutes: unknown[];
      declaredContractReferences: unknown[];
      forbiddenFindings: unknown[];
    };
    expect(Array.isArray(report.publicOperations)).toBe(true);
    expect(Array.isArray(report.ownerOperations)).toBe(true);
    expect(Array.isArray(report.runtimeRoutes)).toBe(true);
    expect(Array.isArray(report.declaredContractReferences)).toBe(true);
    expect(Array.isArray(report.forbiddenFindings)).toBe(true);
  });

  it("reconciles exactly five public operations", () => {
    const bundle = loadBundle("openapi/generated/public-v1.json");
    expect(listOperations(bundle)).toEqual([
      "GET /api/v1/cv/current",
      "POST /api/v1/events",
      "POST /api/v1/projects/{projectId}/feedback",
      "PUT /api/v1/projects/{projectId}/rating",
      "PUT /api/v1/projects/{projectId}/reaction",
    ]);
  });

  it("reconciles the full Owner contract surface with no generic patch or Lab entry", () => {
    const bundle = loadBundle("openapi/generated/owner-v1.json");
    const actual = listOperations(bundle);
    // 40 active operations plus 8 Phase 5 contracts that remain fail-closed.
    expect(actual).toHaveLength(48);
    expect(actual).toContain("PUT /api/owner/v1/configuration/profile");
    expect(actual).toContain("POST /api/owner/v1/exports");
    expect(actual).toContain("GET /api/owner/v1/exports/{exportId}/download");
    expect(actual).toContain("POST /api/owner/v1/content");
    expect(actual).toContain("GET /api/owner/v1/content/{contentId}/history");
    expect(actual).toContain("POST /api/owner/v1/project-status-values/{valueId}/commands/retire");
    expect(JSON.stringify(bundle.paths)).not.toMatch(/\blab\b/i);
    expect(actual.some((op) => op.startsWith("PATCH "))).toBe(false);
  });

  it("reports no undeclared runtime HTTP surface", () => {
    const report = JSON.parse(readFileSync(REPORT, "utf8")) as {
      runtimeRoutes: unknown[];
      undeclaredHttpSurface: unknown[];
    };
    expect(report.runtimeRoutes).toEqual([]);
    expect(report.undeclaredHttpSurface ?? []).toEqual([]);
  });

  it("reports no forbidden Lab, frontend, stub, or provider-leakage surface", () => {
    const report = JSON.parse(readFileSync(REPORT, "utf8")) as {
      forbiddenFindings: unknown[];
    };
    expect(report.forbiddenFindings).toEqual([]);
  });
});
