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
  headers?: Record<string, Reference | Record<string, unknown>>;
  content?: Record<string, { schema: Reference | Record<string, unknown> }>;
};
type Operation = {
  description?: string;
  parameters?: Parameter[];
  requestBody?: {
    content: Record<string, { schema: Reference | Record<string, unknown>; examples?: Record<string, unknown> }>;
  };
  responses: Record<string, Response>;
  security?: Array<Record<string, string[]>>;
};
type Document = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    parameters: Record<string, Exclude<Parameter, Reference>>;
    responses: Record<string, Exclude<Response, Reference>>;
    schemas: Record<string, Record<string, unknown>>;
  };
};

const document = JSON.parse(
  readFileSync("openapi/generated/public-v1.json", "utf8"),
) as Document;

const operations = [
  ["/api/v1/projects/{projectId}/reaction", "put"],
  ["/api/v1/projects/{projectId}/rating", "put"],
  ["/api/v1/projects/{projectId}/feedback", "post"],
  ["/api/v1/events", "post"],
  ["/api/v1/cv/current", "get"],
] as const;

const resolveParameter = (parameter: Parameter) => {
  if (!("$ref" in parameter)) return parameter;
  const name = parameter.$ref.split("/").at(-1);
  if (!name) throw new Error(`Invalid parameter reference: ${parameter.$ref}`);
  return document.components.parameters[name];
};

const resolveResponse = (response: Response) => {
  if (!("$ref" in response)) return response;
  const name = response.$ref.split("/").at(-1);
  if (!name) throw new Error(`Invalid response reference: ${response.$ref}`);
  return document.components.responses[name];
};

const resolveSchema = (schema: Record<string, unknown>) => {
  if (!("$ref" in schema) || typeof schema["$ref"] !== "string") return schema;
  const name = schema["$ref"].split("/").at(-1);
  if (!name) throw new Error(`Invalid schema reference: ${schema["$ref"]}`);
  return document.components.schemas[name];
};

describe("public v1 HTTP semantics", () => {
  it("requires a 1-128 character visible-ASCII idempotency key for every mutation", () => {
    for (const [path, method] of operations.filter(([, verb]) => verb !== "get")) {
      const parameters = document.paths[path]?.[method]?.parameters ?? [];
      const idempotency = parameters.map(resolveParameter).find(
        (parameter) => parameter?.name === "Idempotency-Key",
      );

      expect(idempotency).toMatchObject({
        in: "header",
        required: true,
        schema: {
          minLength: 1,
          maxLength: 128,
          pattern: "^[\\x21-\\x7E]+$",
        },
      });
    }
  });

  it("declares replacement semantics and private pending Feedback", () => {
    const reaction = document.paths["/api/v1/projects/{projectId}/reaction"]?.["put"];
    const rating = document.paths["/api/v1/projects/{projectId}/rating"]?.["put"];
    const feedback = document.paths["/api/v1/projects/{projectId}/feedback"]?.["post"];

    expect(reaction?.description).toMatch(/replaces/i);
    expect(rating?.description).toMatch(/replaces/i);
    expect(feedback?.description).toMatch(/private pending Feedback/i);
    expect(document.components.schemas["ReactionUpdate"]).toMatchObject({
      additionalProperties: false,
      properties: { reaction: { enum: ["like", "dislike"] } },
    });
    expect(document.components.schemas["RatingUpdate"]).toMatchObject({
      additionalProperties: false,
      properties: { rating: { type: "integer", minimum: 1, maximum: 5 } },
    });
    expect(document.components.schemas["FeedbackReceipt"]).toMatchObject({
      properties: { status: { const: "pending" } },
    });
  });

  it("keeps Public event data to the closed nine-event allowlist", () => {
    const event = document.components.schemas["PublicMeasurementEvent"] as {
      discriminator: { propertyName: string; mapping: Record<string, string> };
      oneOf: Reference[];
    };
    const schemaNames = event.oneOf.map((item) => item.$ref.split("/").at(-1));

    expect(event.discriminator.propertyName).toBe("action");
    expect(schemaNames).toEqual([
      "PageViewedEvent",
      "ProjectViewedEvent",
      "ActiveEngagementSampledEvent",
      "MediaEngagedEvent",
      "RelatedProjectOpenedEvent",
      "ContactChannelOpenedEvent",
      "ExternalProjectLinkOpenedEvent",
      "TestimonialEngagedEvent",
      "GlobalProjectCtaOpenedEvent",
    ]);
    expect(Object.keys(event.discriminator.mapping)).toEqual([
      "page-viewed",
      "project-viewed",
      "active-engagement-sampled",
      "media-engaged",
      "related-project-opened",
      "contact-channel-opened",
      "external-project-link-opened",
      "testimonial-engaged",
      "global-project-cta-opened",
    ]);
    for (const schemaName of schemaNames) {
      expect(document.components.schemas[schemaName!]).toMatchObject({
        additionalProperties: false,
      });
    }
    expect(JSON.stringify(event)).not.toMatch(/reaction|rating|feedback|cv/i);
  });

  it("exposes only the English Current CV and declares stream and redirect success", () => {
    const operation = document.paths["/api/v1/cv/current"]?.["get"];
    const locale = operation?.parameters?.map(resolveParameter).find(
      (parameter) => parameter?.name === "locale",
    );

    expect(resolveSchema(locale!.schema)).toMatchObject({ enum: ["en"] });
    expect(operation?.responses).toHaveProperty("200");
    expect(operation?.responses).toHaveProperty("307");
    expect(resolveResponse(operation!.responses["307"]!)).toMatchObject({
      headers: {
        Location: expect.anything(),
        "Cache-Control": expect.anything(),
      },
    });
  });

  it("uses safe RFC Problem Details for every declared error", () => {
    expect(document.components.schemas["Problem"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["type", "title", "status", "detail", "instance", "code", "traceId"],
    });

    const expectedResponses = new Map<string, Record<string, string | null>>([
      ["put /api/v1/projects/{projectId}/reaction", {
        "200": null, "400": "BadRequestProblem", "403": "ForbiddenProblem",
        "404": "NotFoundProblem", "409": "ConflictProblem", "422": "UnprocessableProblem",
        "429": "RateLimitedProblem", "500": "InternalProblem", "503": "TemporarilyUnavailableProblem",
      }],
      ["put /api/v1/projects/{projectId}/rating", {
        "200": null, "400": "BadRequestProblem", "403": "ForbiddenProblem",
        "404": "NotFoundProblem", "409": "ConflictProblem", "422": "UnprocessableProblem",
        "429": "RateLimitedProblem", "500": "InternalProblem", "503": "TemporarilyUnavailableProblem",
      }],
      ["post /api/v1/projects/{projectId}/feedback", {
        "201": null, "400": "BadRequestProblem", "403": "ForbiddenProblem",
        "404": "NotFoundProblem", "409": "ConflictProblem", "422": "UnprocessableProblem",
        "429": "RateLimitedProblem", "500": "InternalProblem", "503": "TemporarilyUnavailableProblem",
      }],
      ["post /api/v1/events", {
        "202": null, "400": "BadRequestProblem", "403": "ForbiddenProblem",
        "409": "ConflictProblem", "422": "UnprocessableProblem", "429": "RateLimitedProblem",
        "500": "InternalProblem", "503": "TemporarilyUnavailableProblem",
      }],
      ["get /api/v1/cv/current", {
        "200": null, "307": null, "400": "BadRequestProblem", "404": "NotFoundProblem",
        "429": "RateLimitedProblem", "500": "InternalProblem", "503": "TemporarilyUnavailableProblem",
      }],
    ]);

    for (const [path, method] of operations) {
      const responses = document.paths[path]?.[method]?.responses ?? {};
      const matrix = expectedResponses.get(`${method} ${path}`)!;
      expect(Object.keys(responses).sort()).toEqual(Object.keys(matrix).sort());
      for (const [status, responseOrReference] of Object.entries(responses)) {
        if (Number(status) < 400) continue;
        expect(responseOrReference).toEqual({
          $ref: `#/components/responses/${matrix[status]}`,
        });
        const response = resolveResponse(responseOrReference);
        expect(response?.content).toEqual({
          "application/problem+json": {
            schema: { $ref: "#/components/schemas/Problem" },
          },
        });
      }
    }

    expect(resolveResponse(document.components.responses["RateLimitedProblem"]!)).toHaveProperty(
      "headers.Retry-After",
    );
  });

  it("contains no forbidden public surface", () => {
    const surface = JSON.stringify({ paths: document.paths });
    expect(surface).not.toMatch(/\/api\/(?:owner|admin)|lab entry|supabase|vercel|kysely|server stub/i);
  });
});
