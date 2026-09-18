import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: process.env.CONTRACT_PUBLIC_INPUT ?? "./openapi/generated/public-v1.json",
  output: {
    path:
      process.env.CONTRACT_PUBLIC_OUTPUT ??
      "./src/contracts/http/v1/generated",
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
