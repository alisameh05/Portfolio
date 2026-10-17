import assert from "node:assert/strict";
import test from "node:test";
import { isLocalValidationProjectId, localLoopbackDockerArguments } from "../../scripts/local-docker-loopback-adapter.mjs";

const projectId = "shipwithali-phase3-0123456789abcdef";
const identity = ["--name", `supabase_db_${projectId}`, "--label", `com.supabase.cli.project=${projectId}`];

test("local Auth fixture identities remain bounded and share the scoped adapter", () => {
  const auth = "shipwithali-auth-0123456789abcdef";
  assert.equal(isLocalValidationProjectId(auth), true);
  assert.equal(isLocalValidationProjectId("shipwithali-auth-01234567-89ab-cdef-0123-456789abcdef"), false);
  assert.deepEqual(localLoopbackDockerArguments(["create", "--name", `supabase_db_${auth}`,
    "--label", `com.supabase.cli.project=${auth}`, "-p", "56322:5432", "image"], auth),
  ["create", "--name", `supabase_db_${auth}`, "--label", `com.supabase.cli.project=${auth}`, "-p", "127.0.0.1:56322:5432", "image"]);
});

test("local Docker adapter explicitly binds only named and labeled fixture publishes", () => {
  const args = ["create", ...identity, "-p", "59322:5432", "--publish=0.0.0.0:59321:8000/tcp", "-p59323:80", "image"];
  assert.deepEqual(localLoopbackDockerArguments(args, projectId),
    ["create", ...identity, "-p", "127.0.0.1:59322:5432", "--publish=127.0.0.1:59321:8000/tcp", "-p127.0.0.1:59323:80", "image"]);
  assert.equal(args[args.indexOf("-p") + 1], "59322:5432");
});

test("local Docker adapter denies wildcard publish-all, foreign identities and unsupported bindings", () => {
  for (const args of [
    ["create", "-P", "image"], ["run", "--publish-all", "image"],
    ["create", "--name", "production", "-p", "59322:5432", "image"],
    ["create", "--name", `supabase_db_${projectId}`, "-p", "59322:5432", "image"],
    ["create", ...identity, "-p", "192.168.1.5:59322:5432", "image"],
    ["create", ...identity, "-p", "59322-59325:5432-5435", "image"],
  ]) assert.throws(() => localLoopbackDockerArguments(args, projectId), /LOCAL_DOCKER_/u);
  assert.throws(() => localLoopbackDockerArguments(["version"], "production"), /LOCAL_DOCKER_PROJECT_SCOPE_INVALID/u);
});

test("local Docker adapter preserves non-publishing commands and private arguments", () => {
  for (const args of [["exec", "db", "psql"], ["inspect", "db"], ["run", "--env", "PRIVATE_VALUE", "image"],
    ["run", ...identity, "-p", "127.0.0.1:59322:5432", "image"]]) {
    assert.deepEqual(localLoopbackDockerArguments(args, projectId), args);
  }
});
