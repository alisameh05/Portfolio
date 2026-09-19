#!/usr/bin/env node
/**
 * ensure-depcruise-support.mjs
 *
 * Shared helper that makes dependency-cruiser 16.10.3 able to parse
 * TypeScript 6.0.x in this repository.
 *
 * Background: dependency-cruiser declares `typescript: ">=2.0.0 <6.0.0"` in
 * `node_modules/dependency-cruiser/src/meta.cjs`. Without a patch, cruising
 * `src/` or fixture directories silently reports "0 modules, 0 dependencies
 * cruised", so provider-leakage, generated-code-leakage, deep-import, and
 * cycle fixtures pass vacuously. `scripts/architecture-check.mjs` used to
 * apply this patch inline; tests invoking `npx depcruise` directly bypassed
 * it and failed depending on execution order.
 *
 * This module exports `ensureDependencyCruiserTsSupport()` so the gate, the
 * architecture checker, and architecture tests all share one deterministic
 * seam. It is safe to call multiple times.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");

export function ensureDependencyCruiserTsSupport(root = ROOT) {
  const metaPath = join(root, "node_modules", "dependency-cruiser", "src", "meta.cjs");
  if (!existsSync(metaPath)) return false;
  try {
    const content = readFileSync(metaPath, "utf8");
    if (content.includes('typescript: ">=2.0.0 <6.0.0"')) {
      writeFileSync(
        metaPath,
        content.replace(
          'typescript: ">=2.0.0 <6.0.0"',
          'typescript: ">=2.0.0 <=6.0.3"',
        ),
        "utf8",
      );
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1].split("\\").join("/").endsWith("scripts/ensure-depcruise-support.mjs");
if (invokedDirectly) {
  const patched = ensureDependencyCruiserTsSupport();
  console.log(
    patched
      ? "✓ dependency-cruiser TypeScript support patched for 6.0.x"
      : "✓ dependency-cruiser TypeScript support already present",
  );
}
