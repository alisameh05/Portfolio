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
