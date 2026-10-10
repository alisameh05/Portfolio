import { describe, expect, it } from "vitest";
import { createStableId, err, ok, type IdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createMediaUploadIntentApplicationService } from "../../src/modules/media/application/upload-intent.js";
import type {
  MediaUploadIntentRepositoryPort,
  UploadIntentReservationInput,
  CompleteUploadIntentInput,
  UploadIntentReceiptRecord,
  SealedUploadCapability,
} from "../../src/modules/media/ports/upload-intent.js";
import type { StableIdGenerator } from "../../src/runtime/ports.js";

const ownerId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0" as StableId<"Owner">;
const portfolioId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1" as StableId<"Portfolio">;
const actor = { kind: "owner" as const, ownerId, sessionId: "private-test" };
const command = {
  actor,
  idempotencyKey: "intent-key-1234567890" as IdempotencyKey,
  kind: "image" as const,
  originalFileName: "../../bad\u0001name.png",
  declaredMediaType: "image/png",
  byteLength: 2048,
  sha256: "a".repeat(64),
};

function uuidV7Generator(): StableIdGenerator {
  let index = 0;
  const ids = [
    "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec0",
    "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec1",
    "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec2",
  ];
  return { generate: () => ids[index++] ?? createStableId("MediaObject") };
}

function sealed(target: string): SealedUploadCapability {
  return { version: 1, nonce: "nonce", ciphertext: target, authenticationTag: "tag" };
}

function repositoryFake() {
  let receipt: UploadIntentReceiptRecord | undefined;
  let capability: SealedUploadCapability | undefined;
  let requestHash: string | undefined;
  const completed: CompleteUploadIntentInput[] = [];
  const reserved: UploadIntentReservationInput[] = [];
  const repository: MediaUploadIntentRepositoryPort = {
    async reserve(input) {
      reserved.push(input);
      if (requestHash !== undefined && requestHash !== input.requestHash) return ok({ kind: "conflict" });
      if (receipt !== undefined && capability !== undefined) return ok({ kind: "replay", receipt, capability });
      requestHash = input.requestHash;
      return ok({ kind: "reserved" });
    },
    async complete(input) {
      completed.push(input);
      receipt = { mediaId: input.mediaId, uploadIntentId: input.uploadIntentId, expiresAt: input.expiresAt };
      capability = input.uploadTarget;
      return ok(undefined);
    },
    async abandon() {},
    async listExpiredAbandoned() { return ok([]); },
    async markCompensated() { return ok(undefined); },
  };
  return { repository, completed, reserved };
}

describe("Media upload-intent application seam", () => {
  it("creates separate UUIDv7 identities and persists the hostile filename only as private metadata", async () => {
    const store = repositoryFake();
    const targetInputs: unknown[] = [];
    let preparations = 0;
    const service = createMediaUploadIntentApplicationService({
      scope: { portfolioId, ownerId },
      repository: store.repository,
      target: {
        async prepare(input) {
          preparations += 1;
          targetInputs.push(input);
          return ok({ uploadTarget: "https://storage.example.test/upload?token=opaque", expiresAt: "2026-10-10T21:00:00.000Z" });
        },
        async removeAbandoned() { return ok(undefined); },
      },
      vault: {
        isAvailable: () => true,
        seal: sealed,
        open: (value) => value.ciphertext,
      },
      ids: uuidV7Generator(),
      clock: { now: () => "2026-10-10T19:00:00.000Z" },
    });

    const result = await service.create(command);
    expect(result).toEqual({ ok: true, value: {
      mediaId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec0",
      aggregateVersion: 1,
      outcome: "media-upload-intent-created",
      uploadIntentId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec1",
      uploadTarget: "https://storage.example.test/upload?token=opaque",
      expiresAt: "2026-10-10T21:00:00.000Z",
    } });
    expect(store.completed).toHaveLength(1);
    expect(store.completed[0]?.originalFileName).toBe(command.originalFileName);
    expect(JSON.stringify(targetInputs)).not.toContain("bad");
    expect(preparations).toBe(1);
  });

  it("replays the committed capability and receipt without preparing a second target", async () => {
    const store = repositoryFake();
    let preparations = 0;
    const service = createMediaUploadIntentApplicationService({
      scope: { portfolioId, ownerId },
      repository: store.repository,
      target: { async prepare() { preparations += 1; return ok({ uploadTarget: "https://storage.example.test/new", expiresAt: "2026-10-10T21:00:00.000Z" }); }, async removeAbandoned() { return ok(undefined); } },
      vault: { isAvailable: () => true, seal: sealed, open: (value) => value.ciphertext },
      ids: uuidV7Generator(),
      clock: { now: () => "2026-10-10T19:00:00.000Z" },
    });

    const first = await service.create(command);
    const replay = await service.create(command);
    expect(replay).toEqual(first);
    expect(preparations).toBe(1);
  });

  it.each([
    ["wrong Owner", { ...command, actor: { ...actor, ownerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea9" as StableId<"Owner"> } }, "MEDIA_OWNER_SCOPE_FORBIDDEN"],
    ["unsupported kind and MIME", { ...command, kind: "image" as const, declaredMediaType: "application/pdf" }, "MEDIA_UPLOAD_TYPE_UNSUPPORTED"],
    ["zero bytes", { ...command, byteLength: 0 }, "MEDIA_UPLOAD_SIZE_OUT_OF_BOUNDS"],
    ["oversized image", { ...command, byteLength: 10 * 1024 * 1024 + 1 }, "MEDIA_UPLOAD_SIZE_OUT_OF_BOUNDS"],
    ["invalid digest", { ...command, sha256: "bad" }, "MEDIA_UPLOAD_SHA256_INVALID"],
    ["NUL in filename", { ...command, originalFileName: "bad\u0000name.png" }, "MEDIA_UPLOAD_FILENAME_INVALID"],
  ])("rejects %s before reservation or Storage", async (_label, input, code) => {
    const store = repositoryFake();
    let preparations = 0;
    const service = createMediaUploadIntentApplicationService({
      scope: { portfolioId, ownerId },
      repository: store.repository,
      target: { async prepare() { preparations += 1; return err({ kind: "temporarily_unavailable", code: "SHOULD_NOT_PREPARE" }); }, async removeAbandoned() { return ok(undefined); } },
      vault: { isAvailable: () => true, seal: sealed, open: (value) => value.ciphertext },
      ids: uuidV7Generator(),
      clock: { now: () => "2026-10-10T19:00:00.000Z" },
    });
    const result = await service.create(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
    expect(store.reserved).toHaveLength(0);
    expect(preparations).toBe(0);
  });

  it("fails closed before reservation when the replay encryption key is unavailable", async () => {
    const store = repositoryFake();
    let preparations = 0;
    const service = createMediaUploadIntentApplicationService({
      scope: { portfolioId, ownerId },
      repository: store.repository,
      target: { async prepare() { preparations += 1; return err({ kind: "temporarily_unavailable", code: "SHOULD_NOT_PREPARE" }); }, async removeAbandoned() { return ok(undefined); } },
      vault: { isAvailable: () => false, seal: sealed, open: (value) => value.ciphertext },
      ids: uuidV7Generator(),
      clock: { now: () => "2026-10-10T19:00:00.000Z" },
    });
    const result = await service.create(command);
    expect(result).toEqual(err({ kind: "temporarily_unavailable", code: "MEDIA_UPLOAD_INTENT_UNAVAILABLE" }));
    expect(store.reserved).toHaveLength(0);
    expect(preparations).toBe(0);
  });
});
