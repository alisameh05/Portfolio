import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupabaseOwnerSessionProvider } from "../../src/modules/identity-access/adapters/supabase-owner-session-provider.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";

const issuer = "http://127.0.0.1:54321/auth/v1";
const ownerId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0";
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const rotatedPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
function token(kid?: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "ES256", ...(kid === undefined ? {} : { kid }) })}.${encode({
    sub: ownerId, session_id: ownerId, iss: issuer, aud: "authenticated", exp: 1_800_000_600,
  })}`;
  return `${body}.${sign("sha256", Buffer.from(body), { key: kid === "rotated" ? rotatedPair.privateKey : pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
const runtimes: ReturnType<typeof createPostgresRuntimeDatabase>[] = [];
function fixture() {
  let now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const runtime = createPostgresRuntimeDatabase("postgres://fixture@127.0.0.1:1/unused");
  runtimes.push(runtime);
  const queries = vi.spyOn(runtime.database.getExecutor(), "executeQuery").mockResolvedValue({
    rows: [{ active: true, provider: "github", subject: "910294", owner_id: ownerId }],
  });
  let kid = "original";
  let unavailable = false;
  const request = vi.fn<typeof fetch>(async () => unavailable ? new Response(null, { status: 503 }) : Response.json({
    keys: [{ ...(kid === "rotated" ? rotatedPair : pair).publicKey.export({ format: "jwk" }), kid, alg: "ES256" }],
  }));
  const provider = createSupabaseOwnerSessionProvider({
    config: { supabaseUrl: "http://127.0.0.1:54321", issuer, audience: "authenticated", ownerAllowlist: ["910294"] },
    stableOwnerId: ownerId, database: runtime.database, request, nowSeconds: () => Math.floor(now / 1_000),
  });
  const verify = (key?: string) => provider.verifyOwnerSession({ sessionToken: token(key), expectedPurpose: "owner_session" });
  return { verify, request, queries, advance: (milliseconds = 30_000) => { now += milliseconds; }, rotate: () => { kid = "rotated"; }, outage: () => { unavailable = true; }, recover: () => { unavailable = false; } };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.resource.close()));
});

describe("production Owner JWKS refresh bounds", () => {
  it("bounds sequential distinct and missing kids across sessions without database calls", async () => {
    const f = fixture();
    for (const key of ["unknown-1", "unknown-1", undefined, "unknown-3", "unknown-4"]) {
      expect(await f.verify(key)).toMatchObject({ ok: false, error: { code: "UNKNOWN_SIGNING_KEY" } });
    }
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.queries).not.toHaveBeenCalled();
  });

  it("discovers a legitimate rotated key after cooldown while preserving known-key sessions", async () => {
    const f = fixture();
    expect((await f.verify("original")).ok).toBe(true);
    f.rotate();
    expect(await f.verify("rotated")).toMatchObject({ ok: false, error: { code: "UNKNOWN_SIGNING_KEY" } });
    expect((await f.verify("original")).ok).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(1);
    f.advance();
    expect((await f.verify("rotated")).ok).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
    for (const key of ["other-1", "other-2"]) await f.verify(key);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("bounds failed refresh attempts while failing closed and retaining fresh known keys", async () => {
    const f = fixture();
    expect((await f.verify("original")).ok).toBe(true);
    f.advance();
    f.outage();
    expect(await f.verify("unknown")).toMatchObject({ ok: false, error: { code: "AUTH_PROVIDER_UNAVAILABLE" } });
    for (const key of ["other-1", "other-2"]) await f.verify(key);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect((await f.verify("original")).ok).toBe(true);
    f.recover();
    f.rotate();
    f.advance();
    expect((await f.verify("rotated")).ok).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent cold requests and bounds cold-cache failures", async () => {
    const f = fixture();
    f.outage();
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => f.verify(`unknown-${index}`)));
    for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: "AUTH_PROVIDER_UNAVAILABLE" } });
    await f.verify("another");
    expect(f.request).toHaveBeenCalledTimes(1);
    f.recover();
    f.advance();
    expect((await f.verify("original")).ok).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("never extends expired-key acceptance during a refresh outage", async () => {
    const f = fixture();
    expect((await f.verify("original")).ok).toBe(true);
    f.advance(300_000);
    f.outage();
    for (let index = 0; index < 3; index += 1) {
      expect(await f.verify("original")).toMatchObject({ ok: false, error: { code: "AUTH_PROVIDER_UNAVAILABLE" } });
    }
    expect(f.request).toHaveBeenCalledTimes(2);
  });
});
