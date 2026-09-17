/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    /**
     * Rule: no-provider-in-domain
     *
     * Domain areas may only import their own domain and shared domain contracts.
     * Provider SDKs (Next.js, Supabase, Kysely, Vercel) are forbidden.
     */
    {
      name: "no-provider-in-domain",
      severity: "error",
      comment:
        "Domain areas must not import provider, framework, or database packages.",
      from: {
        path: "(?:^src/modules/|^tests/fixtures/invalid-deps/[^/]+/modules/)([^/]+)/domain/",
      },
      to: {
        path: [
          "^next(/|$)",
          "^@supabase/",
          "^kysely(/|$)",
          "^@vercel/",
          "^vercel(/|$)",
        ],
      },
    },

    /**
     * Rule: no-provider-in-application
     *
     * Application areas may import their own domain, shared contracts, and
     * other modules' public interfaces. They may NOT import provider SDKs.
     */
    {
      name: "no-provider-in-application",
      severity: "error",
      comment:
        "Application areas must not import provider, framework, or database packages.",
      from: {
        path: "(?:^src/modules/|^tests/fixtures/invalid-deps/[^/]+/modules/)([^/]+)/application/",
      },
      to: {
        path: [
          "^next(/|$)",
          "^@supabase/",
          "^kysely(/|$)",
          "^@vercel/",
          "^vercel(/|$)",
        ],
      },
    },

    /**
     * Rule: no-generated-code-leakage
     *
     * Domain and application areas must not import generated transport types
     * or OpenAPI tooling outside adapter or future composition concerns.
     */
    {
      name: "no-generated-code-leakage",
      severity: "error",
      comment:
        "Generated transport types and tooling must not leak into domain or application layers.",
      from: {
        path: "(?:^src/modules/|^tests/fixtures/invalid-deps/[^/]+/modules/)([^/]+)/(domain|application)/",
      },
      to: {
        path: [
          "^src/contracts/http/",
          "^tests/fixtures/invalid-deps/[^/]+/contracts/http/",
          "^@redocly/",
          "^openapi-typescript",
          "^@hey-api/openapi-ts",
        ],
      },
    },

    /**
     * Rule: no-deep-cross-module-import
     *
     * Modules may only be imported through their public barrel (index.ts).
     * Deep imports into another module's domain/, application/, ports/, or
     * adapters/ are forbidden.
     */
    {
      name: "no-deep-cross-module-import",
      severity: "error",
      comment:
        "Cross-module imports must go through the module barrel (index.ts), not into sub-folders.",
      from: {
        path: "(?:^src/modules/|^tests/fixtures/invalid-deps/[^/]+/modules/)([^/]+)/",
      },
      to: {
        path: "(?:^src/modules/|^tests/fixtures/invalid-deps/[^/]+/modules/)[^/]+/(domain|application|ports|adapters)/",
        pathNot:
          "(?:^src/modules/|^tests/fixtures/invalid-deps/[^/]+/modules/)$1/",
      },
    },

    /**
     * Rule: domain-isolation
     *
     * Domain areas can import only their own domain and shared domain contracts.
     */
    {
      name: "domain-isolation",
      severity: "error",
      comment:
        "Domain areas can import only their own domain and shared domain contracts.",
      from: {
        path: "^src/modules/([^/]+)/domain/",
      },
      to: {
        pathNot: [
          "^src/modules/$1/domain/",
          "^src/shared/domain/",
          "^@shared/domain",
        ],
      },
    },

    /**
     * Rule: no-foreign-adapters
     *
     * Application areas cannot import foreign repositories or adapters.
     */
    {
      name: "no-foreign-adapters",
      severity: "error",
      comment:
        "Application areas cannot import foreign repositories or adapters.",
      from: {
        path: "^src/modules/([^/]+)/application/",
      },
      to: {
        path: "^src/modules/[^/]+/adapters/",
        pathNot: "^src/modules/$1/adapters/",
      },
    },

    /**
     * Rule: no-cycles
     *
     * Dependency cycles between modules are strictly forbidden.
     */
    {
      name: "no-cycles",
      severity: "error",
      comment: "Dependency cycles are forbidden in the modular monolith.",
      from: {},
      to: {
        circular: true,
      },
    },

    /**
     * Rule: no-shared-domain-provider-import
     *
     * Shared domain contracts must not import any provider, framework,
     * database, authentication-provider, OpenAPI, or generated code.
     */
    {
      name: "no-shared-domain-provider-import",
      severity: "error",
      comment:
        "Shared domain contracts must remain provider-neutral.",
      from: {
        path: "^src/shared/domain/",
      },
      to: {
        path: [
          "^next(/|$)",
          "^@supabase/",
          "^kysely(/|$)",
          "^@vercel/",
          "^vercel(/|$)",
          "^src/contracts/http/",
          "^@redocly/",
          "^openapi-typescript",
          "^valibot",
          "^zod",
        ],
      },
    },
  ],

  options: {
    doNotFollow: {
      dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer"],
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: {
      dot: { collapsePattern: "node_modules/[^/]+" },
      archi: { collapsePattern: "node_modules/[^/]+" },
    },
  },
};
