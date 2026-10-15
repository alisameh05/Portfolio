import type { ReactionChangedEvent, RatingChangedEvent, FeedbackSubmittedEvent, FeedbackApprovedEvent, FeedbackRejectedEvent, FeedbackSuppressedEvent, ReactionReceipt, RatingReceipt, FeedbackReceipt, PublicFeedbackView } from "../../src/modules/interaction-moderation/index.js";
import type { PublicMeasurementEvent, EventReceipt, AnalyticsGoalVersionView, VerifiedMeasurementEvidence, IngestPublicEventCommand } from "../../src/modules/measurement/index.js";
type Expect<T extends true> = T;
type Keys<T> = T extends unknown ? keyof T : never;
type PrivateKeys = "visitorId" | "functionalId" | "subject" | "authorName" | "comment" | "paragraph" | "reason" | "decisionHistory";
type Events = ReactionChangedEvent | RatingChangedEvent | FeedbackSubmittedEvent | FeedbackApprovedEvent | FeedbackRejectedEvent | FeedbackSuppressedEvent;
export type EventsArePrivateSafe = Expect<Extract<Keys<Events["payload"]>, PrivateKeys> extends never ? true : false>;
export type ReceiptsArePrivateSafe = Expect<Extract<Keys<ReactionReceipt | RatingReceipt | FeedbackReceipt | EventReceipt>, PrivateKeys> extends never ? true : false>;
export type PublicFeedbackHidesPrivateState = Expect<Extract<keyof PublicFeedbackView, "moderationState" | "state" | "decisionHistory" | "visitorId" | "reason"> extends never ? true : false>;
// These negative assignments are checked by the repository's tsc gate, never executed.
export function checkPhase7Types(event: PublicMeasurementEvent, goal: AnalyticsGoalVersionView, evidence: VerifiedMeasurementEvidence, intake: IngestPublicEventCommand) {
 const context = event.context;
 // @ts-expect-error Project facts are mandatory for project-viewed.
 const missingProject: PublicMeasurementEvent = { action: "project-viewed", context };
 // @ts-expect-error Page views cannot carry an unrelated destination field.
 const wrongFields: PublicMeasurementEvent = { action: "page-viewed", context, destination: "live-demo" };
 // @ts-expect-error Current CV actions are excluded from active Measurement semantics.
 const cv: PublicMeasurementEvent = { action: "cv_download", context };
 // @ts-expect-error Goal snapshot definitions are immutable from creation.
 goal.definition.name = "changed";
 // @ts-expect-error FunctionalVisitor cannot stand in for verified MeasurementVisitor.
 const functional: import("../../src/shared/domain/index.js").StableId<"FunctionalVisitor"> = evidence.subject;
 // @ts-expect-error Intake actors cannot carry functional identity into Measurement.
 const joined: IngestPublicEventCommand = { ...intake, actor: { kind: "visitor", consent: "granted", functionalId: functional } };
 void [missingProject, wrongFields, cv, joined];
}

import type { AggregateReportRow, SafeAggregateReport, SafeReportDimensions, ActivateAnalyticsGoalVersionCommand } from "../../src/modules/measurement/index.js";
import type { ModerateFeedbackCommand } from "../../src/modules/interaction-moderation/index.js";
import type { StableId } from "../../src/shared/domain/index.js";
export function checkReviewRegressions(context: PublicMeasurementEvent["context"], projectId: StableId<"Project">, goalId: StableId<"AnalyticsGoal">, versionId: StableId<"AnalyticsGoalVersion">, moderation: ModerateFeedbackCommand, activation: ActivateAnalyticsGoalVersionCommand) {
 const invalidPage = { action: "page-viewed" as const, context, destination: "live-demo" as const };
 // @ts-expect-error Known wrong action fields are forbidden through variables too.
 const variableEvent: PublicMeasurementEvent = invalidPage;
 // @ts-expect-error Spreads cannot bypass the action-specific field restrictions.
 const spreadEvent: PublicMeasurementEvent = { ...invalidPage };
 // @ts-expect-error Project identity is not a Feedback identity.
 const wrongFeedback: ModerateFeedbackCommand = { ...moderation, feedbackId: projectId };
 // @ts-expect-error Project identity is not an Analytics goal identity.
 const wrongGoal: ActivateAnalyticsGoalVersionCommand = { ...activation, goalId: projectId };
 // @ts-expect-error Goal identity is not a goal version identity.
 const wrongVersion: ActivateAnalyticsGoalVersionCommand = { ...activation, versionId: goalId };
 const actionRow: AggregateReportRow = { metric: "action", action: "project-viewed", utcDay: "2026-10-14", count: 5, dimensions: { locale: "ar", projectId } };
 const goalRow: AggregateReportRow = { metric: "goal", goalId, goalVersionId: versionId, definitionSnapshot: { name: "View", steps: [{ action: "project-viewed", projectIds: [projectId] }] }, utcDay: "2026-10-14", count: 5, dimensions: { locale: "ar" } };
 // @ts-expect-error A goal report cannot omit its goal identity and definition snapshot.
 const anonymousGoal: AggregateReportRow = { metric: "goal", utcDay: "2026-10-14", count: 5, dimensions: {} };
 // @ts-expect-error Identifying report dimensions are excluded.
 const privateDimensions: SafeReportDimensions = { functionalId: projectId };
 const metadata = { utcPeriod: { startDay: "2026-10-14", endDay: "2026-10-14" }, asOf: "2026-10-14T12:00:00Z", incomplete: false, policyVersion: "p7-v1", grouping: "daily-goal" as const, breakdown: "summary" as const };
 const report: SafeAggregateReport = { ...metadata, state: "available", observedSubjects: "five-or-more", sampleState: "sufficient", rows: [goalRow], engagementMeaning: "approximate-active-attention", journeyMeaning: "context-without-causation" };
 // @ts-expect-error Suppressed reports cannot carry detail rows.
 const lowSample: SafeAggregateReport = { ...metadata, state: "low-sample", observedSubjects: "fewer-than-five", rows: [actionRow] };
 void [variableEvent, spreadEvent, wrongFeedback, wrongGoal, wrongVersion, actionRow, goalRow, anonymousGoal, privateDimensions, report, lowSample];
}
