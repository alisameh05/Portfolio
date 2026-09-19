import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const generatedPaths = [
  process.env.CONTRACT_PUBLIC_ZOD ??
    resolve("src/contracts/http/v1/generated/zod.gen.ts"),
  process.env.CONTRACT_OWNER_ZOD ??
    resolve("src/contracts/http/owner/v1/generated/zod.gen.ts"),
];

for (const generatedPath of generatedPaths) {
  const generated = await readFile(generatedPath, "utf8");
  const objectCount = generated.match(/z\.object\(/g)?.length ?? 0;

  if (objectCount === 0) {
    throw new Error(
      `No generated Zod objects were found in ${generatedPath}; review the strict-object compatibility step.`,
    );
  }

  const strict = generated.replaceAll("z.object(", "z.strictObject(");
  await writeFile(generatedPath, strict);
  console.log(`Strictified ${objectCount} generated Zod object schemas in ${generatedPath}.`);
}
