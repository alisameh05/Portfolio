import { sql } from "kysely";
import { err, ok, type Rejection, type Result, type StableId } from "../../../shared/domain/index.js";
import type { TaxonomyOwnerRepository, TaxonomyOwnerScope, TaxonomyKind, TaxonomyEvolutionResult } from "../application/owner-taxonomies.js";
import type { TransactionContext } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { ContentTaxonomyAssignmentsPort } from "../../content-publishing/index.js";
import type { TaxonomyOwnerExportTaxonomyFacts } from "../application/taxonomy-export.js";
import { parseStableId } from "../../../shared/domain/index.js";

const MAX_TAXONOMY_EXPORT_ROWS = 100_000;

// The shared transaction runner bounds lock waits at 5s and statements at 15s.
// Keep merges synchronous and capped; lock timeout/deadlock failures abort the
// enclosing transaction. The service maps them to 503/TAXONOMY_MERGE_RETRYABLE;
// clients may retry with the same idempotency key.
const MAX_PROJECTS_PER_TAXONOMY_MERGE = 500;

function validKind(kind: string): kind is TaxonomyKind {
  return kind === "category" || kind === "ai-ml-domain" || kind === "technology" || kind === "project-type";
}
function setScope(context: TransactionContext, scope: TaxonomyOwnerScope) {
  const executor = resolvePostgresTransaction(context);
  return sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                     set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(executor);
}

export function createPostgresTaxonomyOwnerRepository(): TaxonomyOwnerRepository {
  async function evolveValue(input: {
    readonly valueId: StableId<"TaxonomyValue">;
    readonly expectedVersion: number;
    readonly actorId: StableId<"Owner">;
    readonly scope: TaxonomyOwnerScope;
    readonly name?: string;
    readonly reason?: string;
  }, action: "renamed" | "retired", context: TransactionContext): Promise<Result<TaxonomyEvolutionResult, Rejection>> {
    const executor = resolvePostgresTransaction(context);
    try {
      await setScope(context, input.scope);
      // Assignment eligibility always locks the Taxonomy root before the value.
      // Evolution takes the same locks in the same order so retirement cannot
      // race a late assignment past the active-state check.
      const owner = await sql<{ taxonomy_id: string }>`
        select taxonomy_id::text from taxonomy.taxonomy_values
         where portfolio_id = ${input.scope.portfolioId}::uuid and value_id = ${input.valueId}::uuid
      `.execute(executor);
      const taxonomyId = owner.rows[0]?.taxonomy_id;
      if (taxonomyId === undefined) return err({ kind: "not_found", code: "TAXONOMY_VALUE_NOT_FOUND" });
      const selectedRoot = await sql<{ kind: string; aggregate_version: number }>`
        select kind, aggregate_version from taxonomy.roots
         where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${taxonomyId}::uuid
         for update
      `.execute(executor);
      const root = selectedRoot.rows[0];
      if (root === undefined) return err({ kind: "not_found", code: "TAXONOMY_NOT_FOUND" });
      if (!validKind(root.kind) || !Number.isSafeInteger(root.aggregate_version) || root.aggregate_version < 1) throw new PostgresInfrastructureError();
      if (root.aggregate_version !== input.expectedVersion) return err({ kind: "precondition_failed", code: "TAXONOMY_VERSION_MISMATCH", currentVersion: root.aggregate_version });
      const selectedValue = await sql<{ label: string; state: string }>`
        select label, state from taxonomy.taxonomy_values
         where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${taxonomyId}::uuid and value_id = ${input.valueId}::uuid
         for update
      `.execute(executor);
      const value = selectedValue.rows[0];
      if (value === undefined) return err({ kind: "not_found", code: "TAXONOMY_VALUE_NOT_FOUND" });
      if (value.state !== "active" && value.state !== "retired" && value.state !== "merged") throw new PostgresInfrastructureError();
      if (value.state === "merged") return err({ kind: "conflict", code: "TAXONOMY_VALUE_NOT_ACTIVE" });
      if (action === "renamed" && value.state !== "active") return err({ kind: "conflict", code: "TAXONOMY_VALUE_NOT_ACTIVE" });
      if (action === "retired" && value.state === "retired") {
        return { ok: true as const, value: {
          taxonomyId: taxonomyId as StableId<"Taxonomy">,
          aggregateVersion: root.aggregate_version,
          changed: false,
          label: value.label,
        } satisfies TaxonomyEvolutionResult };
      }
      const nextLabel = action === "renamed" ? input.name : value.label;
      if (nextLabel === undefined) throw new PostgresInfrastructureError();
      if (action === "renamed" && nextLabel === value.label) {
        return { ok: true as const, value: {
          taxonomyId: taxonomyId as StableId<"Taxonomy">,
          aggregateVersion: root.aggregate_version,
          changed: false,
          label: value.label,
        } satisfies TaxonomyEvolutionResult };
      }
      if (action === "renamed") {
        const duplicate = await sql<{ value_id: string }>`
          select value_id::text from taxonomy.taxonomy_values
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${taxonomyId}::uuid
             and normalized_label = lower(regexp_replace(btrim(${nextLabel}), '[[:space:]]+', ' ', 'g'))
             and value_id <> ${input.valueId}::uuid
        `.execute(executor);
        if (duplicate.rows.length > 0) return err({ kind: "conflict", code: "TAXONOMY_VALUE_NAME_ALREADY_EXISTS" });
      }
      const updatedRoot = await sql<{ aggregate_version: number; changed_at: Date | string }>`
        update taxonomy.roots set aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
         where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${taxonomyId}::uuid
         returning aggregate_version, updated_at as changed_at
      `.execute(executor);
      const nextRoot = updatedRoot.rows[0];
      if (nextRoot === undefined || !Number.isSafeInteger(nextRoot.aggregate_version)) throw new PostgresInfrastructureError();
      const nextState = action === "retired" ? "retired" : "active";
      const updatedValue = await sql`
        update taxonomy.taxonomy_values
           set label = ${nextLabel}, state = ${nextState}, aggregate_version = aggregate_version + 1,
               updated_at = transaction_timestamp()
         where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${taxonomyId}::uuid and value_id = ${input.valueId}::uuid
      `.execute(executor);
      if (Number(updatedValue.numAffectedRows) !== 1) throw new PostgresInfrastructureError();
      const sequence = await sql<{ next_sequence: number }>`
        select coalesce(max(transition_sequence), 0)::integer + 1 as next_sequence
          from taxonomy.value_history
         where portfolio_id = ${input.scope.portfolioId}::uuid and value_id = ${input.valueId}::uuid
      `.execute(executor);
      const nextSequence = sequence.rows[0]?.next_sequence;
      if (!Number.isSafeInteger(nextSequence) || nextSequence === undefined) throw new PostgresInfrastructureError();
      const changedAt = nextRoot.changed_at instanceof Date ? nextRoot.changed_at.toISOString() : new Date(nextRoot.changed_at).toISOString();
      if (!Number.isFinite(Date.parse(changedAt))) throw new PostgresInfrastructureError();
      await sql`
        insert into taxonomy.value_history (
          portfolio_id, taxonomy_id, value_id, transition_sequence, action, previous_label, label, state,
          aggregate_version, actor_id, reason, changed_at
        ) values (
          ${input.scope.portfolioId}::uuid, ${taxonomyId}::uuid, ${input.valueId}::uuid, ${nextSequence},
          ${action}, ${value.label}, ${nextLabel}, ${nextState},
          ${nextRoot.aggregate_version}, ${input.actorId}::uuid, ${action === "retired" ? (input.reason ?? null) : null}, ${changedAt}::timestamptz
        )
      `.execute(executor);
      if (action === "renamed") {
        await sql`
          update taxonomy.project_discovery_taxonomy_values set label = ${nextLabel}
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${taxonomyId}::uuid
             and value_id = ${input.valueId}::uuid
        `.execute(executor);
      }
      return { ok: true as const, value: {
        taxonomyId: taxonomyId as StableId<"Taxonomy">,
        aggregateVersion: nextRoot.aggregate_version,
        changed: true,
        previousLabel: value.label,
        label: nextLabel,
      } satisfies TaxonomyEvolutionResult };
    } catch (error) {
      if (error instanceof PostgresInfrastructureError) throw error;
      throw new PostgresInfrastructureError();
    }
  }
  return {
    async readOwnerTaxonomiesForExport(scope, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${scope.ownerId}, true),
                         set_config('shipwithali.worker_purpose', 'taxonomy.owner-export', true)`.execute(executor);
        const captured = await sql<{ captured_at: Date | string }>`select transaction_timestamp() as captured_at`.execute(executor);
        const roots = await sql<{ taxonomy_id: string; aggregate_version: number; kind: string }>`
          select taxonomy_id::text, aggregate_version, kind
            from taxonomy.roots
           where portfolio_id = ${scope.portfolioId}::uuid
           order by taxonomy_id
           limit ${MAX_TAXONOMY_EXPORT_ROWS + 1}
        `.execute(executor);
        const values = await sql<{
          taxonomy_id: string; value_id: string; label: string; state: string;
          value_version: number; merged_into_value_id: string | null;
        }>`
          select taxonomy_id::text, value_id::text, label, state, aggregate_version as value_version,
                 merged_into_value_id::text
            from taxonomy.taxonomy_values
           where portfolio_id = ${scope.portfolioId}::uuid
           order by taxonomy_id, value_id
           limit ${MAX_TAXONOMY_EXPORT_ROWS + 1}
        `.execute(executor);
        const history = await sql<{
          taxonomy_id: string; value_id: string; transition_sequence: number; action: string;
          previous_label: string | null; label: string; state: string;
          changed_at: Date | string;
        }>`
          select taxonomy_id::text, value_id::text, transition_sequence, action, previous_label, label, state,
                 changed_at
            from taxonomy.value_history
           where portfolio_id = ${scope.portfolioId}::uuid
           order by taxonomy_id, value_id, transition_sequence
           limit ${MAX_TAXONOMY_EXPORT_ROWS + 1}
        `.execute(executor);
        if (captured.rows[0] === undefined || roots.rows.length > MAX_TAXONOMY_EXPORT_ROWS ||
            values.rows.length > MAX_TAXONOMY_EXPORT_ROWS || history.rows.length > MAX_TAXONOMY_EXPORT_ROWS) {
          return err({ kind: "temporarily_unavailable", code: "TAXONOMY_EXPORT_LIMIT_EXCEEDED" });
        }
        const capturedAtValue = captured.rows[0].captured_at;
        const capturedAt = capturedAtValue instanceof Date ? capturedAtValue.toISOString() : new Date(capturedAtValue).toISOString();
        if (!Number.isFinite(Date.parse(capturedAt))) throw new PostgresInfrastructureError();
        const parsedRoots = roots.rows.map((row) => {
          const taxonomyId = parseStableId("Taxonomy", row.taxonomy_id);
          if (!taxonomyId.ok || !validKind(row.kind) || !Number.isSafeInteger(row.aggregate_version) || row.aggregate_version < 1) {
            throw new PostgresInfrastructureError();
          }
          return { taxonomyId: taxonomyId.value, aggregateVersion: row.aggregate_version, kind: row.kind };
        });
        const parsedValues = values.rows.map((row) => {
          const taxonomyId = parseStableId("Taxonomy", row.taxonomy_id);
          const valueId = parseStableId("TaxonomyValue", row.value_id);
          const mergedIntoValueId = row.merged_into_value_id === null ? undefined : parseStableId("TaxonomyValue", row.merged_into_value_id);
          if (!taxonomyId.ok || !valueId.ok || mergedIntoValueId !== undefined && !mergedIntoValueId.ok ||
              !Number.isSafeInteger(row.value_version) || row.value_version < 1 ||
              row.state !== "active" && row.state !== "retired" && row.state !== "merged" ||
              (row.state === "merged") !== (mergedIntoValueId !== undefined)) throw new PostgresInfrastructureError();
          return {
            taxonomyId: taxonomyId.value,
            value: {
              valueId: valueId.value, name: row.label, state: row.state,
              valueVersion: row.value_version,
              ...(mergedIntoValueId === undefined ? {} : { mergedIntoValueId: mergedIntoValueId.value }),
            } as const,
          };
        });
        const parsedHistory = history.rows.map((row) => {
          const taxonomyId = parseStableId("Taxonomy", row.taxonomy_id);
          const valueId = parseStableId("TaxonomyValue", row.value_id);
          if (!taxonomyId.ok || !valueId.ok || !Number.isSafeInteger(row.transition_sequence) || row.transition_sequence < 1 ||
              row.action !== "created" && row.action !== "renamed" && row.action !== "retired" && row.action !== "merged" ||
              row.state !== "active" && row.state !== "retired" && row.state !== "merged") throw new PostgresInfrastructureError();
          const changedAtValue = row.changed_at;
          const changedAt = changedAtValue instanceof Date ? changedAtValue.toISOString() : new Date(changedAtValue).toISOString();
          if (!Number.isFinite(Date.parse(changedAt))) throw new PostgresInfrastructureError();
          return {
            taxonomyId: taxonomyId.value,
            history: {
              valueId: valueId.value,
              transitionSequence: row.transition_sequence,
              action: row.action,
              previousName: row.previous_label,
              name: row.label,
              state: row.state,
              changedAt,
            } as const,
          };
        });
        const mergedTargetsByValueId = new Map(parsedValues.map((entry) => [entry.value.valueId, entry.value.mergedIntoValueId]));
        const taxonomies: TaxonomyOwnerExportTaxonomyFacts[] = parsedRoots.map((root) => ({
          ...root,
          values: parsedValues.filter((entry) => entry.taxonomyId === root.taxonomyId).map((entry) => entry.value),
          evolutionHistory: parsedHistory.filter((entry) => entry.taxonomyId === root.taxonomyId).map((entry) => {
            const mergedIntoValueId = mergedTargetsByValueId.get(entry.history.valueId);
            return {
              ...entry.history,
              ...(entry.history.action === "merged" && mergedIntoValueId !== undefined ? { mergedIntoValueId } : {}),
            };
          }),
        }));
        if (parsedValues.some((entry) => !parsedRoots.some((root) => root.taxonomyId === entry.taxonomyId)) ||
            parsedHistory.some((entry) => !parsedRoots.some((root) => root.taxonomyId === entry.taxonomyId))) {
          throw new PostgresInfrastructureError();
        }
        return ok({ capturedAt, taxonomies });
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
  async getOwnerTaxonomy(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setScope(context, input.scope);
        const root = await sql<{ taxonomy_id: string; kind: string; aggregate_version: number }>`
          select taxonomy_id::text, kind, aggregate_version from taxonomy.roots
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${input.taxonomyId}::uuid
        `.execute(executor);
        const row = root.rows[0];
        if (row === undefined) return err({ kind: "not_found", code: "TAXONOMY_NOT_FOUND" });
        if (!validKind(row.kind) || !Number.isSafeInteger(row.aggregate_version) || row.aggregate_version < 1) throw new PostgresInfrastructureError();
        const values = await sql<{ value_id: string; label: string; state: string; merged_into_value_id: string | null }>`
          select value_id::text, label, state, merged_into_value_id::text
            from taxonomy.taxonomy_values
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${input.taxonomyId}::uuid
           order by normalized_label, value_id
        `.execute(executor);
        const history = await sql<{ value_id: string; action: string; previous_label: string | null; label: string; aggregate_version: number; changed_at: Date | string }>`
          select value_id::text, action, previous_label, label, aggregate_version, changed_at
            from taxonomy.value_history
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${input.taxonomyId}::uuid
           order by changed_at desc, value_id, transition_sequence desc
           limit 100
        `.execute(executor);
        return { ok: true, value: {
          taxonomyId: row.taxonomy_id as StableId<"Taxonomy">,
          aggregateVersion: row.aggregate_version,
          kind: row.kind,
          values: values.rows.map((value) => {
            if (value.state !== "active" && value.state !== "retired" && value.state !== "merged") throw new PostgresInfrastructureError();
            if ((value.state === "merged") !== (value.merged_into_value_id !== null)) throw new PostgresInfrastructureError();
            return {
              valueId: value.value_id as StableId<"TaxonomyValue">,
              name: value.label,
              state: value.state,
              ...(value.merged_into_value_id === null ? {} : { mergedIntoValueId: value.merged_into_value_id as StableId<"TaxonomyValue"> }),
            };
          }),
          history: history.rows.map((entry) => {
            if (entry.action !== "created" && entry.action !== "renamed" && entry.action !== "retired" && entry.action !== "merged") throw new PostgresInfrastructureError();
            if (!Number.isSafeInteger(entry.aggregate_version) || entry.aggregate_version < 1) throw new PostgresInfrastructureError();
            const changedAt = entry.changed_at instanceof Date ? entry.changed_at.toISOString() : new Date(entry.changed_at).toISOString();
            if (!Number.isFinite(Date.parse(changedAt))) throw new PostgresInfrastructureError();
            return { valueId: entry.value_id as StableId<"TaxonomyValue">, action: entry.action, previousLabel: entry.previous_label, label: entry.label, aggregateVersion: entry.aggregate_version, changedAt };
          }),
        } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
    async createValue(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setScope(context, input.scope);
        const selected = await sql<{ kind: string; aggregate_version: number }>`
          select kind, aggregate_version from taxonomy.roots
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${input.taxonomyId}::uuid
           for update
        `.execute(executor);
        const root = selected.rows[0];
        if (root === undefined) return err({ kind: "not_found", code: "TAXONOMY_NOT_FOUND" });
        if (!validKind(root.kind) || !Number.isSafeInteger(root.aggregate_version)) throw new PostgresInfrastructureError();
        if (root.aggregate_version !== input.expectedVersion) return err({ kind: "precondition_failed", code: "TAXONOMY_VERSION_MISMATCH", currentVersion: root.aggregate_version });
        const inserted = await sql<{ value_id: string }>`
          insert into taxonomy.taxonomy_values (portfolio_id, taxonomy_id, value_id, label)
          values (${input.scope.portfolioId}::uuid, ${input.taxonomyId}::uuid, ${input.valueId}::uuid, ${input.name})
          on conflict (portfolio_id, taxonomy_id, normalized_label) do nothing
          returning value_id::text
        `.execute(executor);
        if (inserted.rows[0] === undefined) return err({ kind: "conflict", code: "TAXONOMY_VALUE_NAME_ALREADY_EXISTS" });
        const updated = await sql<{ aggregate_version: number; changed_at: Date | string }>`
          update taxonomy.roots set aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${input.taxonomyId}::uuid
           returning aggregate_version, updated_at as changed_at
        `.execute(executor);
        const next = updated.rows[0];
        if (next === undefined) throw new PostgresInfrastructureError();
        const createdAt = next.changed_at instanceof Date ? next.changed_at.toISOString() : new Date(next.changed_at).toISOString();
        if (!Number.isFinite(Date.parse(createdAt))) throw new PostgresInfrastructureError();
        await sql`
          insert into taxonomy.value_history (
            portfolio_id, taxonomy_id, value_id, transition_sequence, action, previous_label, label, state,
            aggregate_version, changed_at
          ) values (${input.scope.portfolioId}::uuid, ${input.taxonomyId}::uuid, ${input.valueId}::uuid, 1,
                    'created', null, ${input.name}, 'active', 1, ${createdAt}::timestamptz)
        `.execute(executor);
        return { ok: true, value: { aggregateVersion: next.aggregate_version } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
    async renameValue(input, context) {
      return evolveValue(input, "renamed", context);
    },
    async retireValue(input, context) {
      return evolveValue(input, "retired", context);
    },
    async mergeValue(input, contentAssignments: ContentTaxonomyAssignmentsPort, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setScope(context, input.scope);
        const sourceValueTaxonomy = await sql<{ taxonomy_id: string }>`
          select taxonomy_id::text from taxonomy.taxonomy_values
           where portfolio_id = ${input.scope.portfolioId}::uuid and value_id = ${input.sourceValueId}::uuid
        `.execute(executor);
        const taxonomyId = sourceValueTaxonomy.rows[0]?.taxonomy_id;
        if (taxonomyId === undefined) return err({ kind: "not_found", code: "TAXONOMY_VALUE_NOT_FOUND" });

        const selectedRoot = await sql<{ aggregate_version: number }>`
          select aggregate_version from taxonomy.roots
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${taxonomyId}::uuid
           for update
        `.execute(executor);
        const root = selectedRoot.rows[0];
        if (root === undefined) return err({ kind: "not_found", code: "TAXONOMY_NOT_FOUND" });
        if (!Number.isSafeInteger(root.aggregate_version) || root.aggregate_version < 1) throw new PostgresInfrastructureError();
        if (root.aggregate_version !== input.expectedVersion) return err({ kind: "precondition_failed", code: "TAXONOMY_VERSION_MISMATCH", currentVersion: root.aggregate_version });

        const selectedValues = await sql<{ value_id: string; label: string; state: string; aggregate_version: number }>`
          select value_id::text, label, state, aggregate_version from taxonomy.taxonomy_values
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${taxonomyId}::uuid
             and value_id in (${input.sourceValueId}::uuid, ${input.targetValueId}::uuid)
           order by value_id for update
        `.execute(executor);
        const source = selectedValues.rows.find((value) => value.value_id === input.sourceValueId);
        const target = selectedValues.rows.find((value) => value.value_id === input.targetValueId);
        if (source === undefined || target === undefined) return err({ kind: "not_found", code: "TAXONOMY_VALUE_NOT_FOUND" });
        if (source.state !== "active" && source.state !== "retired" && source.state !== "merged" ||
            target.state !== "active" && target.state !== "retired" && target.state !== "merged" ||
            !Number.isSafeInteger(source.aggregate_version) || !Number.isSafeInteger(target.aggregate_version)) {
          throw new PostgresInfrastructureError();
        }
        if (source.state === "merged") return err({ kind: "conflict", code: "TAXONOMY_VALUE_ALREADY_MERGED" });
        if (target.state !== "active") return err({ kind: "conflict", code: "TAXONOMY_MERGE_TARGET_NOT_ACTIVE" });

        const projects = await contentAssignments.listProjectsWithValue(input.sourceValueId, MAX_PROJECTS_PER_TAXONOMY_MERGE + 1, context);
        if (!projects.ok) return projects;
        const projectIds = [...new Set(projects.value)].sort();
        if (projectIds.length > MAX_PROJECTS_PER_TAXONOMY_MERGE) {
          return err({ kind: "conflict", code: "TAXONOMY_MERGE_CAPACITY_EXCEEDED" });
        }
        for (const projectId of projectIds) {
          const migrated = await contentAssignments.migrateProjectValues({
            projectId,
            sourceValueId: input.sourceValueId,
            targetValueId: input.targetValueId,
            actorId: input.actorId,
          }, context);
          // Any late failure must abort the surrounding transaction rather than
          // persist a partial multi-Project migration.
          if (!migrated.ok) throw new PostgresInfrastructureError();
        }

        const updatedRoot = await sql<{ aggregate_version: number; changed_at: Date | string }>`
          update taxonomy.roots set aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${taxonomyId}::uuid
           returning aggregate_version, updated_at as changed_at
        `.execute(executor);
        const nextRoot = updatedRoot.rows[0];
        if (nextRoot === undefined || !Number.isSafeInteger(nextRoot.aggregate_version)) throw new PostgresInfrastructureError();
        const updatedSource = await sql<{ aggregate_version: number }>`
          update taxonomy.taxonomy_values
             set state = 'merged', merged_into_value_id = ${input.targetValueId}::uuid,
                 aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${taxonomyId}::uuid
             and value_id = ${input.sourceValueId}::uuid
           returning aggregate_version
        `.execute(executor);
        const nextSourceVersion = updatedSource.rows[0]?.aggregate_version;
        if (!Number.isSafeInteger(nextSourceVersion) || nextSourceVersion === undefined) throw new PostgresInfrastructureError();
        const changedAt = nextRoot.changed_at instanceof Date ? nextRoot.changed_at.toISOString() : new Date(nextRoot.changed_at).toISOString();
        if (!Number.isFinite(Date.parse(changedAt))) throw new PostgresInfrastructureError();
        await sql`
          insert into taxonomy.value_history (
            portfolio_id, taxonomy_id, value_id, transition_sequence, action, previous_label, label, state,
            aggregate_version, actor_id, reason, changed_at
          ) values (
            ${input.scope.portfolioId}::uuid, ${taxonomyId}::uuid, ${input.sourceValueId}::uuid,
            ${nextSourceVersion}, 'merged', ${source.label}, ${source.label}, 'merged',
            ${nextRoot.aggregate_version}, ${input.actorId}::uuid, null, ${changedAt}::timestamptz
          )
        `.execute(executor);
        return { ok: true, value: {
          taxonomyId: taxonomyId as StableId<"Taxonomy">,
          aggregateVersion: nextRoot.aggregate_version,
          changed: true,
          previousLabel: source.label,
          label: source.label,
        } satisfies TaxonomyEvolutionResult };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
  };
}
