/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    /**
     * Rule: no-provider-in-domain
     *
     * Domain areas may only import their own domain and shared domain contracts.
     * Provider SDKs (Next.js, Supabase, Kysely, Vercel, generated OpenAPI code)
     * are forbidden in domain/ and application/ areas.
     */
    {
      name: "no-provider-in-domain",
      severity: "error",
      comment:
        "Domain areas must not import provider, framework, or generated-transport packages.",
      from: {
        path: "^src/modules/[^/]+/domain/",
      },
      to: {
        path: [
          "^next(/|$)",
          "^@supabase/",
          "^kysely(/|$)",
          "^@vercel/",
          "^vercel(/|$)",
          "^src/contracts/http/",
        ],
      },
    },

    /**
     * Rule: no-provider-in-application
     *
     * Application areas may import their own domain, shared contracts, and
     * other modules' public interfaces. They may NOT import providers.
     */
    {
      name: "no-provider-in-application",
      severity: "error",
      comment:
        "Application areas must not import provider, framework, or generated-transport packages.",
      from: {
        path: "^src/modules/[^/]+/application/",
      },
      to: {
        path: [
          "^next(/|$)",
          "^@supabase/",
          "^kysely(/|$)",
          "^@vercel/",
          "^vercel(/|$)",
          "^src/contracts/http/",
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
        path: "^src/modules/([^/]+)/",
        // capture the current module name
        pathNot: "^src/modules/$1/",
      },
      to: {
        path: "^src/modules/([^/]+)/(domain|application|ports|adapters)/",
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
