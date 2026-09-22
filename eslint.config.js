import tseslint from "typescript-eslint";

const correctnessRules = {
  "no-constant-binary-expression": "error",
  "no-dupe-else-if": "error",
  "no-debugger": "error",
  "no-self-assign": "error",
  "no-self-compare": "error",
  "no-unreachable-loop": "error",
  "no-unsafe-finally": "error",
};

export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "openapi/generated/**",
      "src/contracts/http/**/generated/**",
      "evidence/**",
      "tests/fixtures/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    rules: correctnessRules,
  },
  {
    files: ["**/*.{ts,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: correctnessRules,
  },
];
