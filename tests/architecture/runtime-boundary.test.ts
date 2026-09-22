import { describe, expect, it } from "vitest";
import {
  inspectRuntimeArchitecture,
  inspectSourceRecords,
} from "../../scripts/check-runtime-architecture.mjs";

const ROOT = process.cwd();

describe("Phase 2 runtime architecture enforcement (#33)", () => {
  it("keeps the repository runtime inside the approved boundaries", () => {
    const report = inspectRuntimeArchitecture(ROOT);
    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe("pass");
  });

  it.each([
    {
      name: "framework import outside an HTTP or bootstrap adapter",
      file: "src/modules/media/application/leak.ts",
      content: 'import { NextRequest } from "next/server";\n',
      reason: "framework-import-outside-http-bootstrap",
    },
    {
      name: "ambient environment read outside configuration bootstrap",
      file: "src/modules/media/application/leak.ts",
      content: "export const secret = process.env.SECRET;\n",
      reason: "environment-read-outside-configuration-bootstrap",
    },
    {
      name: "generated validator import outside transport code",
      file: "src/modules/media/application/leak.ts",
      content:
        'import { zOwnerMediaResponse } from "../../../contracts/http/owner/v1/generated/zod.gen.js";\n',
      reason: "generated-validator-import-outside-transport",
    },
    {
      name: "business orchestration in a Route Handler",
      file: "src/app/api/owner/route.ts",
      content:
        'import { createMediaService } from "../../../modules/media/application/service.js";\nexport async function POST() { return createMediaService(); }\n',
      reason: "business-orchestration-in-route-handler",
    },
    {
      name: "provider import outside an adapter or composition root",
      file: "src/modules/media/domain/leak.ts",
      content: 'import { createClient } from "@supabase/supabase-js";\n',
      reason: "provider-import-outside-adapter-composition",
    },
    {
      name: "provider import in an HTTP adapter",
      file: "src/runtime/http/leak.ts",
      content: 'import { createClient } from "@supabase/supabase-js";\n',
      reason: "provider-import-outside-adapter-composition",
    },
    {
      name: "provider import in a Route Handler",
      file: "src/app/readyz/route.ts",
      content: 'import "kysely";\nexport async function GET() {}\n',
      reason: "provider-import-outside-adapter-composition",
    },
  ])("rejects $name", ({ file, content, reason }) => {
    const report = inspectSourceRecords([{ file, content }]);
    expect(report.findings).toContainEqual({ file, reason });
  });
});
