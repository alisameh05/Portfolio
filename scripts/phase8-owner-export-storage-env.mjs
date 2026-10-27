export function createOwnerExportStorageChildEnvironment(base, { apiUrl, serviceRoleKey, apiPort }) {
  if (typeof apiUrl !== "string" || typeof serviceRoleKey !== "string" ||
      !Number.isSafeInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new TypeError("PHASE8_OWNER_EXPORT_STORAGE_CHILD_ENV_INVALID");
  }
  return {
    ...base,
    PHASE8_OWNER_EXPORT_STORAGE_URL: apiUrl,
    PHASE8_OWNER_EXPORT_STORAGE_KEY: serviceRoleKey,
    PHASE8_OWNER_EXPORT_STORAGE_PORT: String(apiPort),
  };
}
