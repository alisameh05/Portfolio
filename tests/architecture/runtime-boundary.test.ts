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
    {
      name: "React side-effect import in a Route Handler",
      file: "src/app/livez/route.ts",
      content: 'import "react";\nexport async function GET() {}\n',
      reason: "react-presentation-import",
    },
    {
      name: "React DOM dynamic import in an HTTP adapter",
      file: "src/runtime/http/leak.ts",
      content: 'const renderer = await import("react-dom/server");\n',
      reason: "react-presentation-import",
    },
    {
      name: "bootstrap orchestration import in the liveness Route Handler",
      file: "src/app/livez/route.ts",
      content:
        'import { runPublication } from "../../bootstrap/composition-root.js";\nexport async function GET() { return runPublication(); }\n',
      reason: "route-handler-import-outside-allowlist",
    },
    {
      name: "module barrel import in the readiness Route Handler",
      file: "src/app/readyz/route.ts",
      content:
        'import { runPublication } from "../../modules/content-publication/index.js";\nexport async function GET() { return runPublication(); }\n',
      reason: "route-handler-import-outside-allowlist",
    },
    {
      name: "shared application import in the readiness Route Handler",
      file: "src/app/readyz/route.ts",
      content:
        'import { runPublication } from "../../shared/application/index.js";\nexport async function GET() { return runPublication(); }\n',
      reason: "route-handler-import-outside-allowlist",
    },
    {
      name: "runtime HTTP import in the readiness Route Handler",
      file: "src/app/readyz/route.ts",
      content:
        'import { handleGetCurrentCv } from "../../runtime/http/current-cv.js";\nexport async function GET() { return handleGetCurrentCv(); }\n',
      reason: "route-handler-import-outside-allowlist",
    },
  ])("rejects $name", ({ file, content, reason }) => {
    const report = inspectSourceRecords([{ file, content }]);
    expect(report.findings).toContainEqual({ file, reason });
  });
});
