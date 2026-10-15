import type { StableId } from "@shared/domain";
import type { AnalyticsGoalDefinition } from "./owner-analytics.js";
import type { AnalyticsGoalActivationView } from "./owner-analytics.js";

const WINDOW_MICROSECONDS = 30 * 60 * 1_000_000;

export interface GoalConversionEvent {
  readonly eventId: StableId<"PublicEvent">;
  readonly measurementSubject: StableId<"MeasurementVisitor">;
  readonly action: AnalyticsGoalDefinition["steps"][number]["action"];
  readonly pageRouteIdentity: StableId<"PublicRoute">;
  readonly projectIds: readonly StableId<"Project">[];
  readonly effectiveAt: string;
  readonly acceptedAt: string;
  readonly consentRevision: number;
}

export interface GoalConversionVersion {
  readonly versionId: StableId<"AnalyticsGoalVersion">;
  readonly definition: AnalyticsGoalDefinition;
}

export interface GoalConversionTimeline {
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly versions: readonly GoalConversionVersion[];
  readonly activations: readonly (AnalyticsGoalActivationView & { readonly activationSequence: number })[];
}

export interface GoalConversionProgressEntry {
  readonly measurementSubject: StableId<"MeasurementVisitor">;
  readonly versionId: StableId<"AnalyticsGoalVersion">;
  readonly activationSequence: number;
  readonly firstEffectiveAt: string;
  readonly firstAcceptedAt: string;
  readonly nextStepIndex: number;
  readonly consentRevision: number;
}

export interface GoalConversionProgress {
  readonly version: 1;
  readonly goals: Readonly<Record<string, GoalConversionProgressEntry>>;
}

export interface GoalConversionContribution {
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly versionId: StableId<"AnalyticsGoalVersion">;
  readonly terminalEventId: StableId<"PublicEvent">;
  readonly measurementSubject: StableId<"MeasurementVisitor">;
  readonly convertedAt: string;
  readonly acceptedAt: string;
  readonly consentRevision: number;
  readonly activationSequence: number;
}

export function emptyGoalConversionProgress(): GoalConversionProgress {
  return { version: 1, goals: {} };
}

function instantMicros(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("GOAL_CONVERSION_TIMESTAMP_INVALID");
  const fraction = /\.(\d+)(?:Z|[+-]\d\d:\d\d)$/i.exec(value)?.[1] ?? "";
  return parsed * 1_000 + Number(fraction.padEnd(6, "0").slice(3, 6));
}

function compareInstant(left: string, right: string): number {
  return instantMicros(left) - instantMicros(right);
}

function activeVersionAt(timeline: GoalConversionTimeline, at: string): GoalConversionActivation | undefined {
  let active: GoalConversionActivation | undefined;
  for (const activation of timeline.activations) {
    if (compareInstant(activation.activatedAt, at) > 0) continue;
    if (!active || compareInstant(activation.activatedAt, active.activatedAt) > 0 ||
        (compareInstant(activation.activatedAt, active.activatedAt) === 0 && activation.activationSequence > active.activationSequence)) {
      active = activation;
    }
  }
  return active;
}

interface GoalConversionActivation extends AnalyticsGoalActivationView {
  readonly activationSequence: number;
}

function matchesStep(event: GoalConversionEvent, step: AnalyticsGoalDefinition["steps"][number]): boolean {
  if (event.action !== step.action) return false;
  if (step.publicRouteIds && !step.publicRouteIds.includes(event.pageRouteIdentity)) return false;
  if (step.projectIds && !step.projectIds.some(projectId => event.projectIds.includes(projectId))) return false;
  return true;
}

function compareEvents(left: GoalConversionEvent, right: GoalConversionEvent): number {
  const time = compareInstant(left.effectiveAt, right.effectiveAt) || compareInstant(left.acceptedAt, right.acceptedAt);
  return time || (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0);
}

/** Advances one subject's ordered event stream. Each event advances at most one step per goal. */
export function advanceGoalConversionProgress(
  previous: GoalConversionProgress,
  inputEvents: readonly GoalConversionEvent[],
  timelines: readonly GoalConversionTimeline[],
): { readonly progress: GoalConversionProgress; readonly contributions: readonly GoalConversionContribution[] } {
  if (previous.version !== 1) throw new Error("GOAL_CONVERSION_PROGRESS_VERSION_UNSUPPORTED");
  const goals: Record<string, GoalConversionProgressEntry> = { ...previous.goals };
  const contributions = new Map<string, GoalConversionContribution>();
  const events = [...new Map(inputEvents.map(event => [event.eventId, event])).values()].sort(compareEvents);

  for (const event of events) {
    for (const timeline of timelines) {
      const goalId = timeline.goalId;
      const prior = goals[goalId];
      const activation = activeVersionAt(timeline, event.effectiveAt);
      const version = activation && timeline.versions.find(candidate => candidate.versionId === activation.versionId);
      if (!activation || !version) {
        delete goals[goalId];
        continue;
      }

      let partial = prior;
      if (partial && (partial.measurementSubject !== event.measurementSubject || partial.versionId !== activation.versionId ||
          partial.activationSequence !== activation.activationSequence || partial.consentRevision !== event.consentRevision ||
          instantMicros(event.effectiveAt) - instantMicros(partial.firstEffectiveAt) > WINDOW_MICROSECONDS)) {
        delete goals[goalId];
        partial = undefined;
      }

      if (partial) {
        const step = version.definition.steps[partial.nextStepIndex];
        if (step && matchesStep(event, step)) {
          const nextStepIndex = partial.nextStepIndex + 1;
          if (nextStepIndex === version.definition.steps.length) {
            const contribution: GoalConversionContribution = {
              goalId, versionId: version.versionId, terminalEventId: event.eventId,
              measurementSubject: event.measurementSubject, convertedAt: event.effectiveAt,
              acceptedAt: partial.firstAcceptedAt, consentRevision: event.consentRevision, activationSequence: activation.activationSequence,
            };
            contributions.set(`${goalId}:${version.versionId}:${event.eventId}`, contribution);
            delete goals[goalId];
          } else {
            goals[goalId] = { ...partial, nextStepIndex };
          }
        }
        continue;
      }

      if (!matchesStep(event, version.definition.steps[0]!)) continue;
      if (version.definition.steps.length === 1) {
        const contribution: GoalConversionContribution = {
          goalId, versionId: version.versionId, terminalEventId: event.eventId,
          measurementSubject: event.measurementSubject, convertedAt: event.effectiveAt,
          acceptedAt: event.acceptedAt, consentRevision: event.consentRevision, activationSequence: activation.activationSequence,
        };
        contributions.set(`${goalId}:${version.versionId}:${event.eventId}`, contribution);
      } else {
        goals[goalId] = { measurementSubject: event.measurementSubject, versionId: version.versionId, activationSequence: activation.activationSequence,
          firstEffectiveAt: event.effectiveAt, firstAcceptedAt: event.acceptedAt, nextStepIndex: 1, consentRevision: event.consentRevision };
      }
    }
  }

  return { progress: { version: 1, goals }, contributions: [...contributions.values()] };
}
