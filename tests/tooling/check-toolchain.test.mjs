import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { verifyToolchain } from "../../scripts/check-toolchain.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("rejects Node 22 even though it shares the major version accepted by the old gate", () => {
  const result = verifyToolchain(ROOT, { node: "v22.23.2", npm: "11.19.0" });
  assert.match(result.failures.join("\n"), /runtime node \(v22\.23\.2\) must equal pinned Node 24\.21\.0/);
});

test("rejects another Node 24 patch instead of treating any Node 24 as pinned", () => {
  const result = verifyToolchain(ROOT, { node: "v24.19.0", npm: "11.19.0" });
  assert.match(result.failures.join("\n"), /runtime node \(v24\.19\.0\) must equal pinned Node 24\.21\.0/);
});

test("rejects a different npm patch instead of recording it as accepted", () => {
  const result = verifyToolchain(ROOT, { node: "v24.21.0", npm: "11.18.0" });
  assert.match(result.failures.join("\n"), /runtime npm \(11\.18\.0\) must equal pinned npm 11\.19\.0/);
});
