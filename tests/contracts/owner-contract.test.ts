import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Reference = { $ref: string };
type Parameter = Reference | {
  name: string;
  in: string;
  required?: boolean;
  schema: Record<string, unknown>;
};
type Response = Reference | {
  content?: Record<string, { schema: Reference | Record<string, unknown> }>;
};
type Operation = {
  operationId: string;
  parameters?: Parameter[];
  responses: Record<string, Response>;
  security?: Array<Record<string, string[]>>;
};
type Document = {
  security: Array<Record<string, string[]>>;
  paths: Record<string, Record<string, Operation>>;
  components: {
    parameters: Record<string, Exclude<Parameter, Reference>>;
    responses: Record<string, Exclude<Response, Reference>>;
    schemas: Record<string, Record<string, unknown>>;
    securitySchemes: Record<string, Record<string, unknown>>;
  };
};

const document = JSON.parse(
  readFileSync("openapi/generated/owner-v1.json", "utf8"),
) as Document;
const httpMethods = new Set(["get", "post", "put", "patch", "delete"]);

const expectedOperations = [
  ["/api/owner/v1/content", "post"],
  ["/api/owner/v1/configuration/profile", "put"],
  ["/api/owner/v1/configuration/contact-channels", "put"],
  ["/api/owner/v1/configuration/project-cta", "put"],
  ["/api/owner/v1/content/{contentId}", "get"],
  ["/api/owner/v1/content/{contentId}/revisions", "post"],
  ["/api/owner/v1/content/{contentId}/revisions/{revisionId}/preview", "get"],
  ["/api/owner/v1/content/{contentId}/revisions/{revisionId}/review", "post"],
  ["/api/owner/v1/content/{contentId}/history", "get"],
  ["/api/owner/v1/content/{contentId}/commands/publish-language", "post"],
  ["/api/owner/v1/content/{contentId}/commands/hide", "post"],
  ["/api/owner/v1/content/{contentId}/commands/archive", "post"],
  ["/api/owner/v1/content/{contentId}/commands/restore", "post"],
  ["/api/owner/v1/projects/{projectId}", "get"],
  ["/api/owner/v1/projects/{projectId}/commands/change-status", "post"],
  ["/api/owner/v1/projects/{projectId}/commands/set-featured", "post"],
  ["/api/owner/v1/projects/{projectId}/commands/change-slug", "post"],
  ["/api/owner/v1/projects/{projectId}/commands/correct-candidate-slug", "post"],
  ["/api/owner/v1/projects/{projectId}/commands/relate-project", "post"],
  ["/api/owner/v1/project-status-values", "get"],
  ["/api/owner/v1/project-status-values", "post"],
  ["/api/owner/v1/project-status-values/{valueId}/commands/rename", "post"],
  ["/api/owner/v1/project-status-values/{valueId}/commands/retire", "post"],
  ["/api/owner/v1/taxonomies/{taxonomyId}", "get"],
  ["/api/owner/v1/taxonomies/{taxonomyId}/values", "post"],
  ["/api/owner/v1/taxonomy-values/{valueId}/commands/rename", "post"],
  ["/api/owner/v1/taxonomy-values/{valueId}/commands/retire", "post"],
  ["/api/owner/v1/taxonomy-values/{valueId}/commands/merge", "post"],
  ["/api/owner/v1/projects/{projectId}/commands/assign-taxonomy-value", "post"],
  ["/api/owner/v1/media/{mediaId}", "get"],
  ["/api/owner/v1/media/upload-intents", "post"],
  ["/api/owner/v1/media/{mediaId}/commands/record-processing", "post"],
  ["/api/owner/v1/media/{mediaId}/commands/accept", "post"],
  ["/api/owner/v1/media/{mediaId}/commands/reject", "post"],
  ["/api/owner/v1/cv", "get"],
  ["/api/owner/v1/cv/versions", "post"],
  ["/api/owner/v1/cv/versions/{versionId}/commands/accept", "post"],
  ["/api/owner/v1/cv/versions/{versionId}/commands/activate", "post"],
  ["/api/owner/v1/feedback/{feedbackId}", "get"],
  ["/api/owner/v1/feedback/{feedbackId}/commands/approve", "post"],
  ["/api/owner/v1/feedback/{feedbackId}/commands/reject", "post"],
  ["/api/owner/v1/feedback/{feedbackId}/commands/suppress", "post"],
  ["/api/owner/v1/analytics-goals/{goalId}", "get"],
  ["/api/owner/v1/analytics-goals/{goalId}/versions", "post"],
  ["/api/owner/v1/analytics-goals/{goalId}/commands/activate-version", "post"],
  ["/api/owner/v1/exports", "post"],
  ["/api/owner/v1/exports/{exportId}", "get"],
  ["/api/owner/v1/exports/{exportId}/download", "get"],
] as const;

const aggregateCreationOperations = new Set([
  "createOwnerContent",
  "createOwnerProjectStatusValue",
  "createOwnerMediaUploadIntent",
  "requestOwnerExport",
]);

const resolveParameter = (parameter: Parameter) => {
  if (!("$ref" in parameter)) return parameter;
  const name = parameter.$ref.split("/").at(-1);
  return name ? document.components.parameters[name] : undefined;
};

const resolveResponse = (response: Response) => {
  if (!("$ref" in response)) return response;
  const name = response.$ref.split("/").at(-1);
  return name ? document.components.responses[name] : undefined;
};

describe("Owner v1 contract", () => {
  it("contains exactly the declared command and narrow-query surface", () => {
    const actual = Object.entries(document.paths).flatMap(([path, pathItem]) =>
      Object.keys(pathItem)
        .filter((method) => httpMethods.has(method))
        .map((method) => [path, method]),
    );

    expect(actual.sort()).toEqual([...expectedOperations].sort());
    expect(JSON.stringify(document.paths)).not.toMatch(/\blab\b|\/patch|generic/i);
  });

  it("requires the Owner session globally and distinguishes 401 from 403", () => {
    expect(document.security).toEqual([{ OwnerSession: [] }]);
    expect(document.components.securitySchemes["OwnerSession"]).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "sw_owner_session",
    });

    for (const [path, method] of expectedOperations) {
      const operation = document.paths[path]![method]!;
      expect(operation.security).toBeUndefined();
      expect(operation.responses["401"]).toEqual({
        $ref: "#/components/responses/UnauthenticatedProblem",
      });
      expect(operation.responses["403"]).toEqual({
        $ref: "#/components/responses/ForbiddenProblem",
      });
    }
  });

  it("requires idempotency on creations and optimistic concurrency on aggregate mutations", () => {
    for (const [path, method] of expectedOperations.filter(([, verb]) => verb !== "get")) {
      const operation = document.paths[path]![method]!;
      const parameters = operation.parameters ?? [];
      const resolved = parameters.map(resolveParameter);

      expect(resolved.find((parameter) => parameter?.name === "Idempotency-Key")).toMatchObject({
        in: "header",
        required: true,
        schema: { minLength: 1, maxLength: 128, pattern: "^[\\x21-\\x7E]+$" },
      });
      const concurrencyHeader = resolved.find((parameter) => parameter?.name === "If-Match");
      if (aggregateCreationOperations.has(operation.operationId)) {
        expect(concurrencyHeader).toBeUndefined();
      } else {
        expect(concurrencyHeader).toMatchObject({
          in: "header",
          required: true,
          schema: { pattern: '^"[1-9][0-9]*"$' },
        });
      }
    }
  });

  it("models aggregate views and the accepted domain distinctions", () => {
    expect(document.components.schemas["ContentAggregateView"]).toMatchObject({
      additionalProperties: false,
      properties: {
        lifecycle: { enum: ["draft", "published", "hidden", "archived"] },
        localizedStreams: expect.any(Object),
        revisions: expect.any(Object),
      },
    });
    expect(document.components.schemas["ProjectAggregateView"]).toMatchObject({
      additionalProperties: false,
      properties: {
        featured: { type: "boolean" },
        publicRoute: expect.any(Object),
        relatedProjectIds: expect.any(Object),
        taxonomyAssignments: expect.any(Object),
      },
    });
    expect(document.components.schemas["TaxonomyAggregateView"]).toMatchObject({
      additionalProperties: false,
      properties: { values: expect.any(Object) },
    });
    expect(document.components.schemas["PublishLanguageCommand"]).toMatchObject({
      required: ["locale", "revisionId"],
      additionalProperties: false,
    });
    expect(document.components.schemas["ChangeSlugCommand"]).toMatchObject({
      required: ["slug"],
      additionalProperties: false,
    });
    expect(document.components.schemas["SaveRevisionReceipt"]).toMatchObject({
      required: ["aggregateId", "aggregateVersion", "outcome", "revisionId"],
      additionalProperties: false,
    });
    expect(document.components.schemas["CvPortfolioView"]).toMatchObject({
      required: ["aggregateVersion", "currentVersionId", "versions", "activationHistory"],
      additionalProperties: false,
      properties: {
        currentVersionId: expect.any(Object),
        versions: expect.any(Object),
        activationHistory: expect.any(Object),
      },
    });
    expect(document.components.schemas["RegisterCvVersionRequest"]).toMatchObject({
      required: ["mediaId", "locale", "label"],
      additionalProperties: false,
      properties: { locale: { type: "string", const: "en" } },
    });
    expect(document.components.schemas["FeedbackModerationView"]).toMatchObject({
      required: [
        "feedbackId",
        "aggregateVersion",
        "state",
        "authorName",
        "paragraph",
        "submittedAt",
        "decisionHistory",
      ],
      additionalProperties: false,
      properties: {
        state: { enum: ["pending", "approved", "rejected", "suppressed"] },
        decisionHistory: expect.any(Object),
      },
    });
    expect(document.components.schemas["ModerationDecisionCommand"]).toMatchObject({
      required: ["reason"],
      additionalProperties: false,
    });
    expect(document.components.schemas["MediaAggregateView"]).toMatchObject({
      required: expect.arrayContaining(["processingHistory", "decisionHistory"]),
      additionalProperties: false,
      properties: {
        processingHistory: expect.any(Object),
        decisionHistory: expect.any(Object),
      },
    });
    expect(document.components.schemas["MediaProcessingView"]).toMatchObject({
      required: expect.arrayContaining(["result", "findings", "recordedAt"]),
      additionalProperties: false,
    });
    expect(document.components.schemas["AnalyticsGoalAggregateView"]).toMatchObject({
      required: ["goalId", "aggregateVersion", "activeVersionId", "versions", "activationHistory"],
      additionalProperties: false,
      properties: {
        activeVersionId: expect.any(Object),
        versions: expect.any(Object),
        activationHistory: expect.any(Object),
      },
    });
    expect(document.components.schemas["AnalyticsGoalVersionView"]).toMatchObject({
      required: ["versionId", "versionNumber", "definition", "createdAt"],
      additionalProperties: false,
    });
    expect(document.components.schemas["OwnerExportView"]).toMatchObject({
      oneOf: expect.any(Array),
      discriminator: { propertyName: "state" },
    });
    expect(document.components.schemas["ReadyOwnerExportView"]).toMatchObject({
      required: expect.arrayContaining([
        "exportId",
        "state",
        "schemaVersion",
        "requestedAt",
        "includedScopes",
        "publicEventDataCoverage",
        "integrityManifest",
        "downloadAvailable",
      ]),
      additionalProperties: false,
    });
    expect(document.components.schemas["OwnerExportRecord"]).toMatchObject({
      oneOf: expect.any(Array),
      discriminator: { propertyName: "scope" },
    });
    expect(document.components.schemas["OwnerExportPackageManifest"]).toMatchObject({
      required: expect.arrayContaining(["includedScopes", "publicEventDataCoverage", "entries"]),
      additionalProperties: false,
    });
  });

  it("uses RFC 9457 Problem Details for every declared error", () => {
    expect(document.components.schemas["Problem"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["type", "title", "status", "detail", "instance", "code", "traceId"],
    });

    for (const [path, method] of expectedOperations) {
      const responses = document.paths[path]![method]!.responses;
      for (const [status, response] of Object.entries(responses)) {
        if (Number(status) < 400) continue;
        expect(resolveResponse(response)?.content).toEqual({
          "application/problem+json": {
            schema: { $ref: "#/components/schemas/Problem" },
          },
        });
      }
    }
  });

  it("defines strict creation, review, and bounded-history contracts without broadening public HTTP", () => {
    expect(document.components.schemas["CreateContentRequest"]).toMatchObject({
      oneOf: expect.arrayContaining([
        { $ref: "#/components/schemas/CreateProjectRequest" },
        { $ref: "#/components/schemas/CreateAchievementRequest" },
        { $ref: "#/components/schemas/CreateTestimonialRequest" },
      ]),
      discriminator: { propertyName: "contentType" },
    });
    for (const name of ["CreateProjectRequest", "CreateAchievementRequest", "CreateTestimonialRequest"]) {
      expect(document.components.schemas[name]).toMatchObject({
        additionalProperties: false,
        required: expect.arrayContaining(["contentType", "locale", "title", "summary", "body"]),
      });
    }
    expect(document.components.schemas["CreateProjectRequest"]).toMatchObject({
      properties: { candidateSlug: { type: "string" } },
    });
    expect(document.components.schemas["CreateProjectRequest"]?.["required"]).not.toContain("candidateSlug");
    expect(document.components.schemas["ReviewRevisionCommand"]).toMatchObject({
      additionalProperties: false,
      required: ["locale", "snapshotHash", "evidenceVersion", "decision", "findings"],
    });
    expect(document.components.schemas["ContentHistoryPage"]).toMatchObject({
      additionalProperties: false,
      required: ["entries", "routeHistory", "nextCursor"],
    });
    expect(document.components.schemas["ProjectStatusValueReceipt"]).toMatchObject({
      additionalProperties: false,
      required: ["valueId", "label", "state", "aggregateVersion", "outcome"],
    });
    expect(document.paths["/api/v1"]).toBeUndefined();
    expect(JSON.stringify(document.paths)).not.toMatch(/\/api\/v1\/.*(content|discovery)/);
  });
});
