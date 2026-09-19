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
