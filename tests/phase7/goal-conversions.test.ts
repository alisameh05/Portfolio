import { describe, expect, it } from "vitest";
import { parseStableId, type StableId } from "../../src/shared/domain/index.js";
import { advanceGoalConversionProgress, emptyGoalConversionProgress, type GoalConversionEvent, type GoalConversionTimeline } from "../../src/modules/measurement/application/goal-conversions.js";

function id<T extends string>(kind: T, tail: number): StableId<T> {
  const value = parseStableId(kind, `0196a1b2-7c3d-7e11-9f22-${tail.toString(16).padStart(12, "0")}`);
  if (!value.ok) throw new Error("INVALID_TEST_ID");
  return value.value;
}

const subject = id("MeasurementVisitor", 1);
const otherSubject = id("MeasurementVisitor", 2);
const goalId = id("AnalyticsGoal", 3);
const versionOne = id("AnalyticsGoalVersion", 4);
const versionTwo = id("AnalyticsGoalVersion", 5);
const route = id("PublicRoute", 6);
const project = id("Project", 7);

function event(input: Partial<GoalConversionEvent> & Pick<GoalConversionEvent, "eventId" | "action" | "effectiveAt">): GoalConversionEvent {
  return { eventId: input.eventId, action: input.action, effectiveAt: input.effectiveAt,
    acceptedAt: input.acceptedAt ?? input.effectiveAt, measurementSubject: input.measurementSubject ?? subject,
    pageRouteIdentity: input.pageRouteIdentity ?? route, projectIds: input.projectIds ?? [project], consentRevision: input.consentRevision ?? 1 };
}

function timeline(steps: readonly { action: GoalConversionEvent["action"]; publicRouteIds?: readonly StableId<"PublicRoute">[]; projectIds?: readonly StableId<"Project">[] }[], activations = [{ versionId: versionOne, activatedAt: "2026-10-15T11:00:00.000000Z", activationSequence: 1 }]): GoalConversionTimeline {
  return { goalId, versions: [{ versionId: versionOne, definition: { name: "Goal", steps } },
    { versionId: versionTwo, definition: { name: "Goal revision", steps } }], activations };
}

describe("deterministic Analytics goal conversion matching", () => {
  it("allows unrelated events between scoped steps and contributes once at the terminal event", () => {
    const goal = timeline([
      { action: "project-viewed", projectIds: [project], publicRouteIds: [route] },
      { action: "contact-channel-opened", projectIds: [project] },
    ]);
    const result = advanceGoalConversionProgress(emptyGoalConversionProgress(), [
      event({ eventId: id("PublicEvent", 10), action: "project-viewed", effectiveAt: "2026-10-15T11:05:00Z" }),
      event({ eventId: id("PublicEvent", 11), action: "page-viewed", effectiveAt: "2026-10-15T11:06:00Z" }),
      event({ eventId: id("PublicEvent", 12), action: "contact-channel-opened", effectiveAt: "2026-10-15T11:07:00Z" }),
      event({ eventId: id("PublicEvent", 13), action: "contact-channel-opened", effectiveAt: "2026-10-15T11:08:00Z" }),
    ], [goal]);
    expect(result.contributions).toEqual([{ goalId, versionId: versionOne, terminalEventId: id("PublicEvent", 12),
      measurementSubject: subject, convertedAt: "2026-10-15T11:07:00Z", acceptedAt: "2026-10-15T11:05:00Z",
      consentRevision: 1, activationSequence: 1 }]);
    expect(result.progress.goals[goalId]).toBeUndefined();
  });

  it("rejects reversed or missing steps, route/project scope mismatches, and cross-subject completion", () => {
    const goal = timeline([
      { action: "project-viewed", projectIds: [project], publicRouteIds: [route] },
      { action: "contact-channel-opened", projectIds: [project] },
    ]);
    const events = [
      event({ eventId: id("PublicEvent", 20), action: "contact-channel-opened", effectiveAt: "2026-10-15T11:01:00Z" }),
      event({ eventId: id("PublicEvent", 21), action: "project-viewed", effectiveAt: "2026-10-15T11:02:00Z", pageRouteIdentity: id("PublicRoute", 8) }),
      event({ eventId: id("PublicEvent", 22), action: "project-viewed", effectiveAt: "2026-10-15T11:03:00Z", projectIds: [id("Project", 9)] }),
      event({ eventId: id("PublicEvent", 23), action: "project-viewed", effectiveAt: "2026-10-15T11:04:00Z" }),
      event({ eventId: id("PublicEvent", 24), action: "contact-channel-opened", effectiveAt: "2026-10-15T11:05:00Z", measurementSubject: otherSubject }),
    ];
    const result = advanceGoalConversionProgress(emptyGoalConversionProgress(), events, [goal]);
    expect(result.contributions).toEqual([]);
    expect(result.progress.goals[goalId]).toBeUndefined();
  });

  it("treats 30:00 as inclusive, resets expired partials, and never reuses a completed terminal event", () => {
    const goal = timeline([{ action: "project-viewed" }, { action: "contact-channel-opened" }]);
    const within = advanceGoalConversionProgress(emptyGoalConversionProgress(), [
      event({ eventId: id("PublicEvent", 30), action: "project-viewed", effectiveAt: "2026-10-15T11:00:00Z" }),
      event({ eventId: id("PublicEvent", 31), action: "contact-channel-opened", effectiveAt: "2026-10-15T11:30:00Z" }),
      event({ eventId: id("PublicEvent", 31), action: "contact-channel-opened", effectiveAt: "2026-10-15T11:30:00Z" }),
    ], [goal]);
    expect(within.contributions).toHaveLength(1);
    expect(within.contributions[0]?.terminalEventId).toBe(id("PublicEvent", 31));

    const expired = advanceGoalConversionProgress(emptyGoalConversionProgress(), [
      event({ eventId: id("PublicEvent", 32), action: "project-viewed", effectiveAt: "2026-10-15T11:00:00Z" }),
      event({ eventId: id("PublicEvent", 33), action: "contact-channel-opened", effectiveAt: "2026-10-15T11:30:00.001Z" }),
    ], [goal]);
    expect(expired.contributions).toEqual([]);
    expect(expired.progress.goals[goalId]).toBeUndefined();
  });

  it("never lets one event satisfy two adjacent steps", () => {
    const goal = timeline([{ action: "project-viewed" }, { action: "project-viewed" }]);
    const onlyOne = event({ eventId: id("PublicEvent", 35), action: "project-viewed", effectiveAt: "2026-10-15T11:01:00Z" });
    expect(advanceGoalConversionProgress(emptyGoalConversionProgress(), [onlyOne], [goal]).contributions).toEqual([]);
    const twoEvents = advanceGoalConversionProgress(emptyGoalConversionProgress(), [onlyOne,
      event({ eventId: id("PublicEvent", 36), action: "project-viewed", effectiveAt: "2026-10-15T11:02:00Z" })], [goal]);
    expect(twoEvents.contributions).toHaveLength(1);
    expect(twoEvents.contributions[0]?.terminalEventId).toBe(id("PublicEvent", 36));
  });

  it("uses activation sequence for tied activation times and does not bridge versions", () => {
    const goal = timeline([{ action: "project-viewed" }, { action: "contact-channel-opened" }], [
      { versionId: versionOne, activatedAt: "2026-10-15T11:00:00.000000Z", activationSequence: 1 },
      { versionId: versionTwo, activatedAt: "2026-10-15T11:00:00.000000Z", activationSequence: 2 },
    ]);
    const result = advanceGoalConversionProgress(emptyGoalConversionProgress(), [
      event({ eventId: id("PublicEvent", 40), action: "project-viewed", effectiveAt: "2026-10-15T11:00:00Z" }),
      event({ eventId: id("PublicEvent", 41), action: "contact-channel-opened", effectiveAt: "2026-10-15T11:01:00Z" }),
    ], [goal]);
    expect(result.contributions.map(row => row.versionId)).toEqual([versionTwo]);
    expect(result.contributions[0]?.activationSequence).toBe(2);
  });

  it("matches every contracted Measurement action by its action identity", () => {
    const actions = ["page-viewed", "project-viewed", "active-engagement-sampled", "media-engaged", "related-project-opened",
      "contact-channel-opened", "external-project-link-opened", "testimonial-engaged", "global-project-cta-opened"] as const;
    for (const [index, action] of actions.entries()) {
      const goal = timeline([{ action }]);
      const result = advanceGoalConversionProgress(emptyGoalConversionProgress(), [event({
        eventId: id("PublicEvent", 60 + index), action, effectiveAt: "2026-10-15T11:01:00Z",
      })], [goal]);
      expect(result.contributions, action).toHaveLength(1);
      expect(result.contributions[0]?.versionId, action).toBe(versionOne);
    }
  });

  it("does not match before activation or carry a partial across a later activation boundary", () => {
    const goal = timeline([{ action: "project-viewed" }, { action: "contact-channel-opened" }], [
      { versionId: versionOne, activatedAt: "2026-10-15T11:00:00.000000Z", activationSequence: 1 },
      { versionId: versionTwo, activatedAt: "2026-10-15T11:05:00.000000Z", activationSequence: 2 },
    ]);
    const result = advanceGoalConversionProgress(emptyGoalConversionProgress(), [
      event({ eventId: id("PublicEvent", 80), action: "project-viewed", effectiveAt: "2026-10-15T10:59:59Z" }),
      event({ eventId: id("PublicEvent", 81), action: "project-viewed", effectiveAt: "2026-10-15T11:04:59.999999Z" }),
      event({ eventId: id("PublicEvent", 82), action: "contact-channel-opened", effectiveAt: "2026-10-15T11:05:00Z" }),
    ], [goal]);
    expect(result.contributions).toEqual([]);
    expect(result.progress.goals[goalId]).toBeUndefined();
  });

  it("orders tied events by acceptance time and stable ID for replay-equivalent results", () => {
    const goal = timeline([{ action: "project-viewed" }, { action: "contact-channel-opened" }]);
    const events = [
      event({ eventId: id("PublicEvent", 51), action: "contact-channel-opened", effectiveAt: "2026-10-15T11:01:00Z", acceptedAt: "2026-10-15T11:02:00Z" }),
      event({ eventId: id("PublicEvent", 50), action: "project-viewed", effectiveAt: "2026-10-15T11:01:00Z", acceptedAt: "2026-10-15T11:01:00Z" }),
    ];
    expect(advanceGoalConversionProgress(emptyGoalConversionProgress(), events, [goal])).toEqual(
      advanceGoalConversionProgress(emptyGoalConversionProgress(), [...events].reverse(), [goal]));
  });
});
