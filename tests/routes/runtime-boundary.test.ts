import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeBoundary,
  contractOperations,
  discoverExportedHandlerNames,
  discoverRuntimeAdapterExports,
  FAIL_CLOSED_OWNER_OPERATION_IDS,
} from "../../scripts/check-runtime-boundary.mjs";
import { forbiddenSourceReasons } from "../../scripts/runtime-source-policy.mjs";

const ROOT = process.cwd();

describe("Phase 2 contract-to-adapter runtime boundary (#33)", () => {
  it("maps active operations once and leaves planned Owner contracts without adapters", () => {
    const report = buildRuntimeBoundary(ROOT);

    expect(report.matrix).toHaveLength(53);
    expect(report.matrix.filter((entry) => entry.surface === "public")).toHaveLength(5);
    expect(report.matrix.filter((entry) => entry.surface === "owner")).toHaveLength(48);
    expect(report.matrix.filter((entry) => entry.activation === "active")).toHaveLength(53);
    expect(report.matrix.filter((entry) => entry.activation === "fail-closed")).toHaveLength(0);
    expect(report.matrix.filter((entry) => entry.activation === "active").every((entry) => entry.matches.length === 1)).toBe(true);
    expect(report.matrix.filter((entry) => entry.activation === "fail-closed").every((entry) => entry.matches.length === 0)).toBe(true);
    expect(report.matrix.filter((entry) => entry.activation === "fail-closed").map((entry) => entry.operationId).sort()).toEqual([...FAIL_CLOSED_OWNER_OPERATION_IDS].sort());
    expect(report.checks.find((check) => check.name === "unfinished-owner-operations-fail-closed")?.passed).toBe(true);
  });

  it("rejects adapters that are not declared by either contract", () => {
    const report = buildRuntimeBoundary(ROOT);

    expect(report.undeclaredAdapters).toEqual([]);
    expect(report.invalidAdapters).toEqual([]);
    expect(report.duplicateOperationIds).toEqual([]);
  });

  it("discovers every exported handler declaration form", () => {
    const source = `
      export async function handleAsync() {}
      export function handleSync() {}
      export const handleArrow = async () => {};
      export default function handleDefault() {}
      const local = () => {};
      export { local as handleReExported };
      export { handleForwarded } from "./forwarded.js";
    `;

    expect(discoverExportedHandlerNames(source)).toEqual([
      "handleArrow",
      "handleAsync",
      "handleDefault",
      "handleForwarded",
      "handleReExported",
      "handleSync",
    ]);
  });

  it("counts only callable runtime values as adapters", () => {
    const root = mkdtempSync(join(tmpdir(), "phase2-runtime-adapters-"));
    const adapterRoot = join(root, "src", "runtime", "http");
    mkdirSync(adapterRoot, { recursive: true });
    writeFileSync(
      join(adapterRoot, "fixture.ts"),
      `
        export default function handleDefaultExtra() {}
        type OnlyType = { value: string };
        export type { OnlyType as handleTypeOnly };
        const value = 42;
        export { value as handleNotCallable };
        export { handleForwarded } from "../forwarded.js";
      `,
      "utf8",
    );
    writeFileSync(
      join(root, "src", "runtime", "forwarded.ts"),
      "export function handleForwarded() {}\n",
      "utf8",
    );

    try {
      expect(discoverRuntimeAdapterExports(root)).toEqual([
        expect.objectContaining({ exportName: "handleDefaultExtra", callable: true }),
        expect.objectContaining({ exportName: "handleForwarded", callable: true }),
        expect.objectContaining({ exportName: "handleNotCallable", callable: false }),
        expect.objectContaining({ exportName: "handleTypeOnly", callable: false }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores handler syntax that appears only in comments or strings", () => {
    const source = `
      // export async function handleCommentOnly() {}
      const example = "export const handleStringOnly = async () => {}";
      /* export { local as handleBlockCommentOnly }; */
    `;

    expect(discoverExportedHandlerNames(source)).toEqual([]);
  });

  it("counts every OpenAPI Path Item operation method", () => {
    const operations = contractOperations(
      {
        paths: {
          "/api/v1/probe": {
            parameters: [],
            get: { operationId: "getProbe" },
            head: { operationId: "headProbe" },
            options: { operationId: "optionsProbe" },
            trace: { operationId: "traceProbe" },
          },
        },
      },
      "public",
    );

    expect(operations.map((operation) => operation.operationId)).toEqual([
      "getProbe",
      "headProbe",
      "optionsProbe",
      "traceProbe",
    ]);
  });

  it("keeps /livez and /readyz as the only operational routes", () => {
    const report = buildRuntimeBoundary(ROOT);

    expect(report.operationalRoutes).toEqual([
      "src/app/livez/route.ts",
      "src/app/readyz/route.ts",
    ]);
    expect(report.unexpectedRouteFiles).toEqual([]);
  });

  it.each(["src/app/livez/route.ts", "src/app/readyz/route.ts"])(
    "still scans forbidden source content in %s",
    (file) => {
      const reasons = forbiddenSourceReasons(
        file,
        'import React from "react"; localStorage.setItem("lab-entry", "server stub");',
      );
      expect(reasons).toEqual(
        expect.arrayContaining([
          "react-presentation-import",
          "browser-state",
          "lab-entry-surface",
          "generated-server-stub",
        ]),
      );
    },
  );

  it.each([
    'import "react";',
    'import React from "react";',
    'export { createElement } from "react";',
    'const React = require("react");',
    'const React = await import("react");',
    'import { renderToString } from "react-dom/server";',
  ])("rejects React presentation import form: %s", (content) => {
    expect(forbiddenSourceReasons("src/app/livez/route.ts", content)).toContain(
      "react-presentation-import",
    );
  });

  it("emits the durable Phase 2 runtime-boundary evidence", () => {
    const reportPath = join(ROOT, "evidence", "phase-2-runtime-boundary.json");
    expect(existsSync(reportPath)).toBe(true);

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      verdict: string;
      matrix: unknown[];
    };
    expect(report.verdict).toBe("pass");
    expect(report.matrix).toHaveLength(53);
  });
});
