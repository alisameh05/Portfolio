import { beforeEach, describe, expect, it, vi } from "vitest";

const { initializeDatabaseRuntime, getOwnerConfigurationHttpDependencies } = vi.hoisted(() => ({
  initializeDatabaseRuntime: vi.fn(),
  getOwnerConfigurationHttpDependencies: vi.fn(() => ({})),
}));

vi.mock("../../src/bootstrap/composition-root.js", () => ({
  getRuntimeEnvironmentSnapshot: () => ({}),
  initializeDatabaseRuntime,
  getOwnerConfigurationHttpDependencies,
}));

vi.mock("../../src/runtime/http/owner-configuration.js", () => ({
  handleUpdateOwnerContactChannels: async () => Response.json({ dispatched: true }),
  handleUpdateOwnerGlobalProjectCta: async () => Response.json({ dispatched: true }),
  handleUpdateOwnerProfileConfiguration: async () => Response.json({ dispatched: true }),
}));

import { dispatchOwnerConfigurationHttp } from "../../src/runtime/http/owner-configuration-http.js";

describe("Owner configuration HTTP bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries initialization after a transient failure and dispatches the recovered request", async () => {
    initializeDatabaseRuntime.mockRejectedValueOnce(new Error("temporary database outage"))
      .mockResolvedValueOnce(undefined);
    const request = new Request("https://example.com/api/owner/v1/configuration/profile", { method: "PUT" });

    const unavailable = await dispatchOwnerConfigurationHttp(request, "updateOwnerProfileConfiguration");
    const recovered = await dispatchOwnerConfigurationHttp(request, "updateOwnerProfileConfiguration");

    expect(unavailable.status).toBe(503);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ dispatched: true });
    expect(initializeDatabaseRuntime).toHaveBeenCalledTimes(2);
    expect(getOwnerConfigurationHttpDependencies).toHaveBeenCalledTimes(1);
  });
});
