import assert from "node:assert/strict";
import test from "node:test";
import { readOptionalGitAlternates } from "../../scripts/git-object-alternates.mjs";

test("Docker qualification supports ordinary Git checkouts without object alternates", () => {
  assert.equal(readOptionalGitAlternates("missing", () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }), "");
  assert.equal(readOptionalGitAlternates("present", () => "\r\n C:/shared/objects \r\n"), "C:/shared/objects");
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.throws(() => readOptionalGitAlternates("denied", () => { throw denied; }), (error) => error === denied);
});
