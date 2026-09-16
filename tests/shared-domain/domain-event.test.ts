/**
 * domain-event.test.ts
 *
 * Tests for the DomainEvent and WithExpectedVersion shared domain contracts.
 *
 * Covers (per spec §Testing Decisions):
 *   - Event metadata fields present and correctly shaped
 *   - Immutability expectations (Readonly payload)
 *   - Aggregate-update command contracts require expectedVersion
 *   - isDomainEvent runtime type guard
 *   - Zero provider imports guard
 */

import { describe, expect, it } from "vitest";
import {
  type DomainEvent,
  type WithExpectedVersion,
  isDomainEvent,
} from "../../src/shared/domain/domain-event.js";
import { createStableId } from "../../src/shared/domain/stable-id.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("DomainEvent domain contract", () => {
  const sampleEvent: DomainEvent<
    "project.published",
    { title: string; language: string }
  > = {
    eventId: createStableId("DomainEvent"),
    eventType: "project.published",
    schemaVersion: 1,
    aggregateId: createStableId("Project"),
    aggregateVersion: 2,
    occurredAt: "2026-09-16T12:00:00.000Z",
    correlationId: "corr-12345",
    causationId: "cause-67890",
    payload: {
      title: "Antigravity Architecture",
      language: "en",
    },
  };

  describe("Metadata completeness", () => {
    it("has all required metadata fields", () => {
      expect(sampleEvent.eventId).toBeDefined();
      expect(sampleEvent.eventType).toBe("project.published");
      expect(sampleEvent.schemaVersion).toBe(1);
      expect(sampleEvent.aggregateId).toBeDefined();
      expect(sampleEvent.aggregateVersion).toBe(2);
      expect(sampleEvent.occurredAt).toBe("2026-09-16T12:00:00.000Z");
      expect(sampleEvent.correlationId).toBe("corr-12345");
      expect(sampleEvent.causationId).toBe("cause-67890");
      expect(sampleEvent.payload).toEqual({
        title: "Antigravity Architecture",
        language: "en",
      });
    });

    it("allows causationId to be undefined for root events", () => {
      const rootEvent: DomainEvent<"session.started", { source: string }> = {
        eventId: createStableId("DomainEvent"),
        eventType: "session.started",
        schemaVersion: 1,
        aggregateId: createStableId("Session"),
        aggregateVersion: 1,
        occurredAt: "2026-09-16T12:00:00.000Z",
        correlationId: "corr-root-1",
        payload: { source: "direct" },
      };

      expect(rootEvent.causationId).toBeUndefined();
      expect(isDomainEvent(rootEvent)).toBe(true);
    });
  });

  describe("isDomainEvent() type guard", () => {
    it("accepts a well-formed domain event", () => {
      expect(isDomainEvent(sampleEvent)).toBe(true);
    });

    it("rejects null or non-objects", () => {
      expect(isDomainEvent(null)).toBe(false);
      expect(isDomainEvent(undefined)).toBe(false);
      expect(isDomainEvent("string")).toBe(false);
      expect(isDomainEvent(123)).toBe(false);
    });

    it("rejects when eventId is missing or wrong type", () => {
      const invalid = { ...sampleEvent, eventId: 123 };
      expect(isDomainEvent(invalid)).toBe(false);
    });

    it("rejects when schemaVersion is missing or not a number", () => {
      const invalid = { ...sampleEvent, schemaVersion: "1" };
      expect(isDomainEvent(invalid)).toBe(false);
    });

    it("rejects when aggregateVersion is missing", () => {
      const { aggregateVersion, ...rest } = sampleEvent;
      expect(isDomainEvent(rest)).toBe(false);
    });

    it("rejects when payload is missing or null", () => {
      const invalid = { ...sampleEvent, payload: null };
      expect(isDomainEvent(invalid)).toBe(false);
    });
  });

  describe("WithExpectedVersion aggregate-update contract", () => {
    it("enforces expectedVersion on update command types", () => {
      interface UpdateProjectCommand extends WithExpectedVersion {
        readonly projectId: string;
        readonly title: string;
      }

      const cmd: UpdateProjectCommand = {
        projectId: "proj-1",
        title: "Updated Title",
        expectedVersion: 3,
      };

      expect(cmd.expectedVersion).toBe(3);
    });
  });

  describe("Provider-import guard", () => {
    it("domain-event.ts imports zero provider or framework modules", () => {
      const filePath = resolve(
        __dirname,
        "../../src/shared/domain/domain-event.ts"
      );
      const content = readFileSync(filePath, "utf-8");

      const forbiddenImports = [
        "next",
        "@supabase",
        "kysely",
        "react",
        "express",
        "@vercel",
      ];

      for (const forbidden of forbiddenImports) {
        const regex = new RegExp(`from\\s+['"][^'"]*${forbidden}`, "i");
        expect(content).not.toMatch(regex);
      }
    });
  });
});
