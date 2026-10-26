import { describe, expect, it } from "vitest";
import { createOwnerExportStorageChildEnvironment } from "../../scripts/phase8-owner-export-storage-env.mjs";

describe("Phase 8 isolated Storage runner environment", () => {
  it("passes the selected loopback API port to the standard export child", () => {
    const child = createOwnerExportStorageChildEnvironment({ PATH: "inherited" }, {
      apiUrl: "http://127.0.0.1:61427", serviceRoleKey: "synthetic-key", apiPort: 61427,
    });
    expect(child).toMatchObject({
      PATH: "inherited",
      PHASE8_OWNER_EXPORT_STORAGE_URL: "http://127.0.0.1:61427",
      PHASE8_OWNER_EXPORT_STORAGE_KEY: "synthetic-key",
      PHASE8_OWNER_EXPORT_STORAGE_PORT: "61427",
    });
    expect(child.PHASE8_OWNER_EXPORT_STORAGE_PORT).not.toBe("56321");
  });
});
