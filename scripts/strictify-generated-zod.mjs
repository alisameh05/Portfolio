import { readFile, writeFile } from "node:fs/promises";

const generatedPath = new URL(
  "../src/contracts/http/v1/generated/zod.gen.ts",
  import.meta.url,
);
const generated = await readFile(generatedPath, "utf8");
const objectCount = generated.match(/z\.object\(/g)?.length ?? 0;

if (objectCount === 0) {
  throw new Error(
    "No generated Zod objects were found; review the strict-object compatibility step.",
  );
}

const strict = generated.replaceAll("z.object(", "z.strictObject(");
await writeFile(generatedPath, strict);
console.log(`Strictified ${objectCount} generated Zod object schemas.`);
