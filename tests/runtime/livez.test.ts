/**
 * livez.test.ts — Phase 2 #25
 *
 * Liveness probe tests: GET /livez returns 200 with a minimal live status
 * whenever the process can answer, without inspecting configuration,
 * application fakes, databases, or external dependencies.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GET } from "../../src/app/livez/route.js";

const ROOT = process.cwd();

describe("GET /livez (#25)", () => {
  it("returns 200 with a minimal live status", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({ status: "live" });
  });

  it("answers without initialized runtime configuration", async () => {
    // Liveness must not depend on bootstrap: no init, no env, still 200.
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "live" });
  });

  it("does not inspect configuration, fakes, databases, or external deps", () => {
    const content = readFileSync(join(ROOT, "src/app/livez/route.ts"), "utf8");
    expect(content).not.toMatch(/process\s*\.\s*env/);
    expect(content).not.toMatch(
      /from\s+["'][^"']*(composition-root|bootstrap\/configuration)/,
    );
    expect(content).not.toMatch(/getRuntimeConfig\s*\(|initializeRuntime\s*\(/);
    // Provider/database access would appear as imports; external calls as fetch(http.
    // (Prose mentions in comments do not count.)
    expect(content).not.toMatch(/from\s+["'][^"']*(kysely|supabase|database)/i);
    expect(content).not.toMatch(/fetch\s*\(\s*["']https?:/i);
  });

  it("exposes no frontend surface alongside the operational route", () => {
    const content = readFileSync(join(ROOT, "src/app/livez/route.ts"), "utf8");
    expect(content).not.toMatch(/from\s+["']react["']/);
    expect(content).not.toMatch(/localStorage|sessionStorage|indexedDB|document\s*\.\s*cookie/);
  });
});
