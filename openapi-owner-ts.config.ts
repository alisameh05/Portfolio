import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: process.env.CONTRACT_OWNER_INPUT ?? "./openapi/generated/owner-v1.json",
  output: {
    path:
      process.env.CONTRACT_OWNER_OUTPUT ??
      "./src/contracts/http/owner/v1/generated",
    clean: true,
  },
  plugins: [
    "@hey-api/typescript",
    {
      name: "zod",
      definitions: true,
      requests: true,
      responses: true,
    },
  ],
});
