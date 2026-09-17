import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./openapi/generated/owner-v1.json",
  output: {
    path: "./src/contracts/http/owner/v1/generated",
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
