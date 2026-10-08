import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type JsonObject = Record<string, any>;

const baselinePath = "tests/fixtures/contract-compatibility/baseline.json";
const checkerPath = "scripts/check-contract-compatibility.mjs";
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as JsonObject;
const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) =>
    rmSync(directory, { recursive: true, force: true }),
  );
});

function candidateWith(change: (document: JsonObject) => void): string {
  const document = structuredClone(baseline);
  change(document);
  const directory = mkdtempSync(join(tmpdir(), "shipwithali-compatibility-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "candidate.json");
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

function runCompatibility(candidatePath: string) {
  return spawnSync(
    process.execPath,
    [checkerPath, "--baseline", baselinePath, "--candidate", candidatePath, "--surface", "fixture"],
    { encoding: "utf8" },
  );
}

function runCompatibilityAgainst(baselineDocument: JsonObject, candidateDocument: JsonObject) {
  const directory = mkdtempSync(join(tmpdir(), "shipwithali-compatibility-pair-"));
  temporaryDirectories.push(directory);
  const baselineFile = join(directory, "baseline.json");
  const candidateFile = join(directory, "candidate.json");
  writeFileSync(baselineFile, `${JSON.stringify(baselineDocument, null, 2)}\n`);
  writeFileSync(candidateFile, `${JSON.stringify(candidateDocument, null, 2)}\n`);
  return spawnSync(
    process.execPath,
    [checkerPath, "--baseline", baselineFile, "--candidate", candidateFile, "--surface", "fixture"],
    { encoding: "utf8" },
  );
}

function relationshipReceiptContract(): JsonObject {
  const document = structuredClone(baseline);
  document["paths"]["/api/owner/v1/projects/{projectId}/commands/relate-project"] = {
    post: {
      operationId: "relateOwnerProjects",
      responses: {
        "200": {
          description: "Related",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  outcome: { type: "string", enum: ["configuration-updated", "project-related"] },
                },
              },
            },
          },
        },
      },
    },
  };
  return document;
}

describe("contract compatibility gate", () => {
  it("accepts additive optional input and response fields", () => {
    const candidatePath = candidateWith((document) => {
      document["components"].schemas.CreateWidget.properties.label = { type: "string" };
      document["components"].schemas.Widget.properties.description = { type: "string" };
      document["paths"]["/widgets/{widgetId}"] = {
        get: {
          operationId: "getWidget",
          responses: { "200": { description: "Found" } },
        },
      };
    });

    const result = runCompatibility(candidatePath);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("backward compatible");
  });

  it("allows only the relationship receipt outcome to narrow to project-related", () => {
    const baselineDocument = relationshipReceiptContract();
    const candidateDocument = structuredClone(baselineDocument);
    candidateDocument["paths"][
      "/api/owner/v1/projects/{projectId}/commands/relate-project"
    ].post.responses["200"].content["application/json"].schema.properties.outcome.enum = [
      "project-related",
    ];

    const result = runCompatibilityAgainst(baselineDocument, candidateDocument);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("backward compatible");
  });

  it("rejects a relationship receipt narrowed to an unrelated outcome", () => {
    const baselineDocument = relationshipReceiptContract();
    const candidateDocument = structuredClone(baselineDocument);
    candidateDocument["paths"][
      "/api/owner/v1/projects/{projectId}/commands/relate-project"
    ].post.responses["200"].content["application/json"].schema.properties.outcome.enum = [
      "configuration-updated",
    ];

    const result = runCompatibilityAgainst(baselineDocument, candidateDocument);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("enum narrowed");
  });

  it("rejects the same enum narrowing on a different response path", () => {
    const baselineDocument = relationshipReceiptContract();
    const relationPath = "/api/owner/v1/projects/{projectId}/commands/relate-project";
    baselineDocument["paths"]["/api/owner/v1/projects/{projectId}/commands/update-status"] =
      structuredClone(baselineDocument["paths"][relationPath]);
    const candidateDocument = structuredClone(baselineDocument);
    candidateDocument["paths"][
      "/api/owner/v1/projects/{projectId}/commands/update-status"
    ].post.responses["200"].content["application/json"].schema.properties.outcome.enum = [
      "project-related",
    ];

    const result = runCompatibilityAgainst(baselineDocument, candidateDocument);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("enum narrowed");
  });

  it.each([
    ["removed field", (document: JsonObject) => {
      delete document["components"].schemas.CreateWidget.properties.note;
    }, "removed"],
    ["renamed field", (document: JsonObject) => {
      document["components"].schemas.CreateWidget.properties.displayName =
        document["components"].schemas.CreateWidget.properties.name;
      delete document["components"].schemas.CreateWidget.properties.name;
    }, "removed"],
    ["narrower input", (document: JsonObject) => {
      document["components"].schemas.CreateWidget.properties.mode.enum = ["standard"];
    }, "narrowed"],
    ["newly required input", (document: JsonObject) => {
      document["components"].schemas.CreateWidget.properties.locale = { type: "string" };
      document["components"].schemas.CreateWidget.required.push("locale");
    }, "new required input"],
    ["changed security", (document: JsonObject) => {
      document["security"] = [{ DifferentSession: [] }];
    }, "security changed"],
    ["changed status semantics", (document: JsonObject) => {
      document["paths"]["/widgets"].post.responses["202"] =
        document["paths"]["/widgets"].post.responses["201"];
      delete document["paths"]["/widgets"].post.responses["201"];
    }, "response status 201 removed"],
  ])("rejects a %s", (_name, change, expectedMessage) => {
    const candidatePath = candidateWith(change);

    const result = runCompatibility(candidatePath);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(expectedMessage);
  });

  it("fails clearly when the compatibility baseline is unavailable", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [checkerPath, "--baseline", "missing-baseline.json", "--candidate", baselinePath],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).toThrow(/baseline.*not found/i);
  });
});
