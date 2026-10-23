import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const generatedPaths = [
  process.env.CONTRACT_PUBLIC_ZOD ??
    resolve("src/contracts/http/v1/generated/zod.gen.ts"),
  process.env.CONTRACT_OWNER_ZOD ??
    resolve("src/contracts/http/owner/v1/generated/zod.gen.ts"),
];

function appendValueRefinement(generated, schemaName, refinement) {
  const declarationStart = generated.indexOf(`export const ${schemaName} = `);
  const declarationEnd = generated.indexOf("\n});", declarationStart);
  if (declarationStart === -1 || declarationEnd === -1 ||
      !generated.slice(declarationStart, declarationEnd).includes("value: z.intersection(")) {
    throw new Error(`Could not find generated Zod declaration ${schemaName}.`);
  }

  return `${generated.slice(0, declarationEnd)}.superRefine(${refinement})${generated.slice(declarationEnd)}`;
}

// openapi-ts does not emit OpenAPI if/then refinements into Zod, so keep the
// Owner package's cross-field integrity rules in the deterministic generator.
function preserveOwnerExportSemantics(generated) {
  let refined = appendValueRefinement(
    generated,
    "zMediaMetadataExportRecord",
    `(value, context) => {
    if (value.portableReference !== undefined) {
        if (value.state !== 'accepted') {
            context.addIssue({ code: 'custom', path: ['portableReference'], message: 'Portable media bytes require accepted media.' });
        }
        if (!/^assets\\/media-metadata\\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.portableReference)) {
            context.addIssue({ code: 'custom', path: ['portableReference'], message: 'Portable media references must use the package asset path.' });
        }
    }
    if (value.processingHistoryTruncated === true && value.processingHistory.length !== 100) {
        context.addIssue({ code: 'custom', path: ['processingHistory'], message: 'A truncated processing history must contain the 100-entry bound.' });
    }
    if (value.decisionHistoryTruncated === true && value.decisionHistory.length !== 100) {
        context.addIssue({ code: 'custom', path: ['decisionHistory'], message: 'A truncated decision history must contain the 100-entry bound.' });
    }
}`,
  );
  refined = appendValueRefinement(
    refined,
    "zCvMetadataExportRecord",
    `(value, context) => {
    if (value.versionsTruncated === true && value.versions.length !== 100) {
        context.addIssue({ code: 'custom', path: ['versions'], message: 'A truncated CV version history must contain the 100-entry bound.' });
    }
    if (value.activationHistoryTruncated === true && value.activationHistory.length !== 100) {
        context.addIssue({ code: 'custom', path: ['activationHistory'], message: 'A truncated activation history must contain the 100-entry bound.' });
    }
}`,
  );
  return refined;
}

for (const generatedPath of generatedPaths) {
  const generated = await readFile(generatedPath, "utf8");
  const objectCount = generated.match(/z\.object\(/g)?.length ?? 0;

  if (objectCount === 0) {
    throw new Error(
      `No generated Zod objects were found in ${generatedPath}; review the strict-object compatibility step.`,
    );
  }

  let strict = generated.replaceAll("z.object(", "z.strictObject(");
  if (generatedPath.replaceAll("\\", "/").endsWith("/src/contracts/http/owner/v1/generated/zod.gen.ts")) {
    strict = preserveOwnerExportSemantics(strict);
    console.log("Preserved Owner export media and history refinements in generated Zod validators.");
  }
  await writeFile(generatedPath, strict);
  console.log(`Strictified ${objectCount} generated Zod object schemas in ${generatedPath}.`);
}
