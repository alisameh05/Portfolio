import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("public v1 contract", () => {
  it("exposes exactly the five approved operations", () => {
    const contract = JSON.parse(readFileSync("openapi/generated/public-v1.json", "utf8"));
    const operations = Object.entries(contract.paths).flatMap(([path, item]) =>
      Object.keys(item as object).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(operations.sort()).toEqual([
      "GET /api/v1/cv/current",
      "POST /api/v1/events",
      "POST /api/v1/projects/{projectId}/feedback",
      "PUT /api/v1/projects/{projectId}/rating",
      "PUT /api/v1/projects/{projectId}/reaction",
    ]);
  });
});
