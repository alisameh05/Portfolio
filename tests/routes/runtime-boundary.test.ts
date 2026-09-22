import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeBoundary,
  contractOperations,
  discoverExportedHandlerNames,
} from "../../scripts/check-runtime-boundary.mjs";
import { forbiddenSourceReasons } from "../../scripts/runtime-source-policy.mjs";

const ROOT = process.cwd();

describe("Phase 2 contract-to-adapter runtime boundary (#33)", () => {
  it("maps every public and Owner operation identifier to exactly one adapter", () => {
    const report = buildRuntimeBoundary(ROOT);

    expect(report.matrix).toHaveLength(44);
    expect(report.matrix.filter((entry) => entry.surface === "public")).toHaveLength(5);
    expect(report.matrix.filter((entry) => entry.surface === "owner")).toHaveLength(39);
    expect(report.matrix.every((entry) => entry.matches.length === 1)).toBe(true);
  });

  it("rejects adapters that are not declared by either contract", () => {
    const report = buildRuntimeBoundary(ROOT);

    expect(report.undeclaredAdapters).toEqual([]);
    expect(report.duplicateOperationIds).toEqual([]);
  });

  it("discovers every exported handler declaration form", () => {
    const source = `
      export async function handleAsync() {}
      export function handleSync() {}
      export const handleArrow = async () => {};
      const local = () => {};
      export { local as handleReExported };
      export { handleForwarded } from "./forwarded.js";
    `;

    expect(discoverExportedHandlerNames(source)).toEqual([
      "handleArrow",
      "handleAsync",
      "handleForwarded",
      "handleReExported",
      "handleSync",
    ]);
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
    expect(report.matrix).toHaveLength(44);
  });
});
