const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stable(value) { return typeof value === "string" && ID.test(value); }
function recordMap(records) {
  const byScope = new Map();
  for (const record of records) {
    const rows = byScope.get(record.scope) ?? [];
    rows.push(record);
    byScope.set(record.scope, rows);
  }
  return byScope;
}

function identitiesByScopeAndKind(byScope) {
  const result = new Map();
  const add = (scope, kind, id) => {
    if (!stable(id)) return;
    const kinds = result.get(scope) ?? new Map();
    const ids = kinds.get(kind) ?? new Set();
    ids.add(id);
    kinds.set(kind, ids);
    result.set(scope, kinds);
  };
  for (const [scope, records] of byScope) {
    for (const record of records) {
      const value = record.value;
      if (scope === "portfolio-content") {
        if (value.contentType === "project") add(scope, "project", value.contentId);
        const routeId = object(value.publicRoute) ? value.publicRoute.identity : value.publicRouteIdentity;
        add(scope, "public-route", routeId);
      } else if (scope === "taxonomy") {
        add(scope, "taxonomy", value.taxonomyId);
        for (const item of value.values ?? []) add(scope, "taxonomy-value", item.valueId);
      } else if (scope === "media-metadata") {
        add(scope, "media-asset", value.mediaId);
      } else if (scope === "cv-metadata") {
        for (const version of (value.cv ?? value).versions ?? []) add(scope, "cv-version", version.versionId);
      } else if (scope === "moderation-history") {
        add(scope, "feedback", value.feedbackId);
      } else if (scope === "analytics-reports") {
        add(scope, "analytics-goal", value.goal?.goalId);
        for (const version of value.goal?.versions ?? []) add(scope, "analytics-goal-version", version.versionId);
      }
    }
  }
  return result;
}

function hasIdentity(index, scope, kind, id) {
  return index.get(scope)?.get(kind)?.has(id) ?? false;
}

function hasAnyIdentity(index, scope, id) {
  return [...(index.get(scope)?.values() ?? [])].some((ids) => ids.has(id));
}

function mediaReferences(value, sourceScope, sourceId, add) {
  if (Array.isArray(value)) value.forEach((item) => mediaReferences(item, sourceScope, sourceId, add));
  else if (object(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (key === "mediaAssetId" && stable(nested)) add(sourceScope, sourceId, "media-metadata", nested, "media-asset");
      else mediaReferences(nested, sourceScope, sourceId, add);
    }
  }
}

function expectedEdges(byScope) {
  const edges = new Map();
  const targetKinds = new Map();
  const selectedProjectRequired = new Set();
  const add = (sourceScope, sourceId, targetScope, targetId, targetKind, requireSelectedProject = false) => {
    if (!stable(sourceId) || !stable(targetId)) fail("REFERENCE_IMPORT_MODEL_REFERENCE_INVALID");
    const key = [sourceScope, sourceId, targetScope, targetId].join("|");
    const previousKind = targetKinds.get(key);
    if (previousKind !== undefined && previousKind !== targetKind) fail("REFERENCE_IMPORT_MODEL_DEPENDENCY_TARGET_KIND_INVALID");
    edges.set(key, { sourceScope, sourceId, targetScope, targetId });
    targetKinds.set(key, targetKind);
    if (requireSelectedProject) selectedProjectRequired.add(key);
  };
  for (const [scope, records] of byScope) for (const record of records) {
    const value = record.value;
    if (scope === "portfolio-content") {
      for (const id of value.relatedProjectIds ?? []) add(scope, value.contentId, scope, id, "project", true);
      for (const id of value.taxonomyValueIds ?? []) add(scope, value.contentId, "taxonomy", id, "taxonomy-value");
      for (const id of value.mediaAssetIds ?? []) add(scope, value.contentId, "media-metadata", id, "media-asset");
      for (const assignment of value.taxonomyAssignments ?? []) add(scope, value.contentId, "taxonomy", assignment.valueId, "taxonomy-value");
      mediaReferences(value.evidenceItems, scope, value.contentId, add);
      mediaReferences(value.revisions, scope, value.contentId, add);
    } else if (scope === "taxonomy") {
      for (const assignment of [...(value.assignments ?? []), ...(value.assignmentHistory ?? [])]) {
        if (assignment.targetId !== undefined) add(scope, value.taxonomyId, "portfolio-content", assignment.targetId, "project", true);
        if (assignment.taxonomyValueId !== undefined) add(scope, value.taxonomyId, scope, assignment.taxonomyValueId, "taxonomy-value");
      }
      for (const item of value.values ?? []) {
        const target = item.mergedIntoValueId ?? item.mergedIntoId;
        if (target !== undefined) add(scope, value.taxonomyId, scope, target, "taxonomy-value");
      }
      for (const item of value.evolutionHistory ?? []) {
        if (item.mergedIntoValueId !== undefined) add(scope, value.taxonomyId, scope, item.mergedIntoValueId, "taxonomy-value");
      }
    } else if (scope === "cv-metadata") {
      for (const version of (value.cv ?? value).versions ?? []) add(scope, version.versionId, "media-metadata", version.mediaId, "media-asset");
    } else if (scope === "portfolio-configuration") {
      const mediaAssetId = object(value.profile) ? value.profile.mediaAssetId : undefined;
      if (mediaAssetId !== undefined && mediaAssetId !== null) add(scope, mediaAssetId, "media-metadata", mediaAssetId, "media-asset");
    } else if (scope === "moderation-history") {
      if (stable(value.projectId)) add(scope, value.feedbackId, "portfolio-content", value.projectId, "project");
    } else if (scope === "analytics-reports") {
      const goal = value.goal;
      for (const version of goal?.versions ?? []) for (const step of version.definition?.steps ?? []) {
        for (const id of step.projectIds ?? []) add(scope, goal.goalId, "portfolio-content", id, "project");
        for (const id of step.publicRouteIds ?? []) add(scope, goal.goalId, "portfolio-content", id, "public-route");
      }
    }
  }
  return { edges, targetKinds, selectedProjectRequired };
}

function contentProjections(records) {
  const projections = [];
  const projectIds = new Set(records.filter((record) => record.value.contentType === "project").map((record) => record.value.contentId));
  const revisionIds = new Set();
  const discovery = [];
  for (const record of records) {
    const value = record.value;
    const legacyV1 = record.schemaVersion === "1.0";
    if (!stable(value.contentId) || !["project", "achievement", "testimonial"].includes(value.contentType) ||
        !["draft", "published", "hidden", "archived"].includes(value.lifecycle)) fail("REFERENCE_IMPORT_MODEL_CONTENT_INVALID");
    if (!Array.isArray(value.revisions) || (!legacyV1 && (!Array.isArray(value.publications) || !Array.isArray(value.publicationHistory)))) {
      fail("REFERENCE_IMPORT_MODEL_CONTENT_HISTORY_INVALID");
    }
    const revisions = new Map();
    for (const revision of value.revisions) {
      if (!stable(revision.revisionId) || revisionIds.has(revision.revisionId) || revisions.has(revision.revisionId) ||
          !["en", "ar"].includes(revision.locale) || !Number.isSafeInteger(revision.sequence) || revision.sequence < 1) {
        fail("REFERENCE_IMPORT_MODEL_REVISION_IDENTITY_INVALID");
      }
      revisionIds.add(revision.revisionId);
      revisions.set(revision.revisionId, revision);
    }
    const publicationsByLocale = new Map();
    if (legacyV1) {
      const currentByLocale = new Set();
      for (const revision of value.revisions) {
        if (typeof revision.reviewed !== "boolean" || typeof revision.currentlyPublished !== "boolean" ||
            revision.currentlyPublished && currentByLocale.has(revision.locale)) fail("REFERENCE_IMPORT_MODEL_REVISION_CURRENT_INVALID");
        if (revision.currentlyPublished) currentByLocale.add(revision.locale);
      }
    } else {
      for (const publication of value.publications) {
        const revision = revisions.get(publication.revisionId);
        if (revision === undefined || revision.locale !== publication.locale || publicationsByLocale.has(publication.locale)) {
          fail("REFERENCE_IMPORT_MODEL_PUBLICATION_POINTER_INVALID");
        }
        const history = value.publicationHistory.filter((entry) => entry.locale === publication.locale);
        const latest = history.reduce((selected, entry) => selected === undefined || entry.sequence > selected.sequence ? entry : selected, undefined);
        if (latest === undefined || latest.sequence !== publication.publicationSequence || latest.revisionId !== publication.revisionId ||
            latest.reviewId !== publication.reviewId || !revision.reviews?.some((review) => review.reviewId === publication.reviewId && review.decision === "accepted")) {
          fail("REFERENCE_IMPORT_MODEL_PUBLICATION_HISTORY_INVALID");
        }
        if (history.some((entry) => !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || !revisions.has(entry.revisionId)) ||
            new Set(history.map((entry) => entry.sequence)).size !== history.length) fail("REFERENCE_IMPORT_MODEL_PUBLICATION_HISTORY_INVALID");
        publicationsByLocale.set(publication.locale, publication);
      }
      for (const revision of value.revisions) {
        if (revision.currentlyPublished !== (publicationsByLocale.get(revision.locale)?.revisionId === revision.revisionId)) {
          fail("REFERENCE_IMPORT_MODEL_REVISION_CURRENT_INVALID");
        }
      }
    }
    const legacyPublicLocales = legacyV1 ? [...new Set(value.revisions.filter((revision) => revision.currentlyPublished).map((revision) => revision.locale))].sort() : [];
    const publicLocales = value.lifecycle === "published" ? (legacyV1 ? legacyPublicLocales : [...publicationsByLocale.keys()].sort()) : [];
    const route = value.publicRoute;
    if (!legacyV1 && route !== null && route !== undefined) {
      const current = route.reservations?.filter((reservation) => reservation.isCurrent) ?? [];
      if (!stable(route.identity) || value.publicRouteIdentity !== route.identity || current.length !== 1 ||
          current[0].slug !== route.canonicalSlug || (value.routeHistory ?? []).some((redirect) =>
            !route.reservations.some((reservation) => reservation.slug === redirect.fromSlug) || redirect.toSlug !== route.canonicalSlug)) {
        fail("REFERENCE_IMPORT_MODEL_ROUTE_IDENTITY_INVALID");
      }
      projections.push({ kind: "public-route", identity: route.identity, value: {
        contentId: value.contentId, canonicalSlug: route.canonicalSlug, reservations: route.reservations,
        redirects: value.routeHistory ?? [], history: route.history ?? [],
        publiclyResolvable: value.lifecycle === "published" && publicLocales.length > 0,
      } });
    } else if (legacyV1) {
      if (value.publicRouteIdentity !== null && !stable(value.publicRouteIdentity)) fail("REFERENCE_IMPORT_MODEL_ROUTE_IDENTITY_INVALID");
      if (stable(value.publicRouteIdentity)) projections.push({ kind: "public-route", identity: value.publicRouteIdentity, value: {
        contentId: value.contentId, canonicalSlug: null, canonicalSlugAvailable: false,
        reservations: null, routeReservationHistoryAvailable: false, redirects: value.routeHistory,
        publiclyResolvable: null,
      } });
    } else if (value.publicRouteIdentity !== null) fail("REFERENCE_IMPORT_MODEL_ROUTE_IDENTITY_INVALID");
    for (const target of value.relatedProjectIds ?? []) {
      if (!stable(target)) fail("REFERENCE_IMPORT_MODEL_RELATIONSHIP_INVALID");
      projections.push({ kind: "content-relationship", identity: `${value.contentId}:${target}`,
        value: { contentId: value.contentId, relatedContentId: target, selected: projectIds.has(target),
          history: (value.relationshipHistory ?? []).filter((entry) => entry.relatedProjectId === target || entry.rightProjectId === target) } });
    }
    for (const assignment of value.taxonomyAssignments ?? []) {
      if (!stable(assignment.valueId)) fail("REFERENCE_IMPORT_MODEL_RELATIONSHIP_INVALID");
      projections.push({ kind: "content-taxonomy-assignment", identity: `${value.contentId}:${assignment.taxonomyId ?? "unknown"}:${assignment.valueId}`,
        value: { contentId: value.contentId, taxonomyId: assignment.taxonomyId ?? null, valueId: assignment.valueId,
          selectedTaxonomy: false, state: null, currentMeaningId: null } });
    }
    const item = {
      contentId: value.contentId, contentType: value.contentType, lifecycle: value.lifecycle,
      projectStatus: value.projectStatus ?? null, featured: value.featured === true,
      revisions: value.revisions, publications: legacyV1 ? null : value.publications,
      publicationHistory: legacyV1 ? null : value.publicationHistory,
      publicationHistoryAvailable: !legacyV1,
      publicationInterpretation: legacyV1 ? "legacy-current-flags-only" : "versioned-publication-history",
      lifecycleHistory: value.lifecycleHistory ?? [], publicRouteIdentity: value.publicRouteIdentity ?? null,
      routeReservationHistoryAvailable: !legacyV1,
      routeHistory: value.routeHistory ?? [], relatedProjectIds: value.relatedProjectIds ?? [],
      relationshipHistory: value.relationshipHistory ?? [], taxonomyAssignments: value.taxonomyAssignments ?? [],
      mediaAssetIds: value.mediaAssetIds ?? [], publicLocales,
      publiclyDiscoverable: value.lifecycle === "published" && publicLocales.length > 0,
      firstPublishedAt: value.firstPublishedAt ?? null,
      discoveryOrderAvailable: !legacyV1 && typeof value.firstPublishedAt === "string",
    };
    projections.push({ kind: "content-item", identity: value.contentId, value: item });
    for (const revision of value.revisions) projections.push({ kind: "content-revision", identity: revision.revisionId,
      value: { contentId: value.contentId, locale: revision.locale, sequence: revision.sequence,
        reviewed: revision.reviewed ?? null, currentlyPublished: revision.currentlyPublished } });
    if (item.publiclyDiscoverable && item.discoveryOrderAvailable) discovery.push({ contentId: value.contentId, firstPublishedAt: value.firstPublishedAt });
  }
  discovery.sort((left, right) => right.firstPublishedAt.localeCompare(left.firstPublishedAt) || right.contentId.localeCompare(left.contentId));
  for (const [position, entry] of discovery.entries()) projections.push({ kind: "public-discovery-entry", identity: entry.contentId,
    value: { ...entry, position: position + 1, tieBreaker: "content-id-desc" } });
  return projections;
}

function taxonomyProjections(records) {
  const projections = [];
  const allValues = new Map();
  for (const record of records) {
    const value = record.value;
    if (!stable(value.taxonomyId) || !Array.isArray(value.values) || !Array.isArray(value.evolutionHistory ?? [])) {
      fail("REFERENCE_IMPORT_MODEL_TAXONOMY_INVALID");
    }
    for (const item of value.values) {
      if (!stable(item.valueId) || allValues.has(item.valueId) || !["active", "retired", "merged"].includes(item.state)) {
        fail("REFERENCE_IMPORT_MODEL_TAXONOMY_VALUE_INVALID");
      }
      allValues.set(item.valueId, item);
    }
  }
  const resolve = (id) => {
    const seen = new Set();
    let current = allValues.get(id);
    while (current?.state === "merged") {
      if (seen.has(current.valueId) || !stable(current.mergedIntoValueId)) fail("REFERENCE_IMPORT_MODEL_TAXONOMY_MERGE_INVALID");
      seen.add(current.valueId);
      current = allValues.get(current.mergedIntoValueId);
      if (current === undefined) fail("REFERENCE_IMPORT_MODEL_TAXONOMY_MERGE_INVALID");
    }
    return current?.valueId ?? null;
  };
  for (const record of records) {
    const value = record.value;
    const historyByValue = new Map();
    for (const event of value.evolutionHistory ?? []) {
      if (!stable(event.valueId) || !Number.isSafeInteger(event.transitionSequence) || event.transitionSequence < 1) {
        fail("REFERENCE_IMPORT_MODEL_TAXONOMY_HISTORY_INVALID");
      }
      const history = historyByValue.get(event.valueId) ?? [];
      history.push(event);
      historyByValue.set(event.valueId, history);
    }
    for (const item of value.values) {
      const history = historyByValue.get(item.valueId) ?? [];
      const latest = history.reduce((selected, entry) => selected === undefined || entry.transitionSequence > selected.transitionSequence ? entry : selected, undefined);
      if (history.length > 0 && (new Set(history.map((entry) => entry.transitionSequence)).size !== history.length || latest?.state !== item.state || latest.name !== item.name)) {
        fail("REFERENCE_IMPORT_MODEL_TAXONOMY_HISTORY_INVALID");
      }
    }
    for (const item of value.values) projections.push({ kind: "taxonomy-value", identity: item.valueId,
      value: { taxonomyId: value.taxonomyId, name: item.name, state: item.state, mergedIntoValueId: item.mergedIntoValueId ?? null,
        currentMeaningId: resolve(item.valueId) } });
    projections.push({ kind: "taxonomy", identity: value.taxonomyId, value: {
      taxonomyId: value.taxonomyId, kind: value.kind, aggregateVersion: value.aggregateVersion,
      values: value.values, evolutionHistory: value.evolutionHistory ?? [], assignments: value.assignments ?? [],
      assignmentHistory: value.assignmentHistory ?? [],
    } });
    for (const assignment of value.assignments ?? []) {
      const assignedValue = allValues.get(assignment.taxonomyValueId ?? assignment.valueId);
      const assignedId = assignment.taxonomyValueId ?? assignment.valueId;
      if (!stable(assignment.targetId) || !stable(assignedId) || assignedValue === undefined) fail("REFERENCE_IMPORT_MODEL_TAXONOMY_ASSIGNMENT_INVALID");
      projections.push({ kind: "taxonomy-assignment", identity: `${value.taxonomyId}:${assignment.targetId}:${assignedId}`,
        value: { taxonomyId: value.taxonomyId, targetId: assignment.targetId, valueId: assignedId,
          assignedAt: assignment.assignedAt ?? null, valueState: assignedValue.state, currentMeaningId: resolve(assignedId) } });
    }
  }
  return projections;
}

function mediaProjections(records, assets) {
  const byDigest = new Map(assets.map((asset) => [asset.digest, asset]));
  return records.map((record) => {
    const value = record.value;
    if (!stable(value.mediaId)) fail("REFERENCE_IMPORT_MODEL_MEDIA_IDENTITY_INVALID");
    const includedBytes = (value.portableAssets ?? []).map((asset) => {
      const digest = asset.digest;
      const object = byDigest.get(digest);
      if (asset.byteCoverage === "included" && object === undefined) fail("REFERENCE_IMPORT_MODEL_MEDIA_BYTES_MISSING");
      return { variantName: asset.variantName, digest, byteLength: asset.byteLength, objectPath: object?.objectPath ?? null,
        byteCoverage: asset.byteCoverage };
    });
    const accepted = value.state === "accepted";
    if (!accepted && includedBytes.length > 0 && includedBytes.some((asset) => asset.byteCoverage === "included")) {
      fail("REFERENCE_IMPORT_MODEL_INELIGIBLE_MEDIA_BYTES");
    }
    return { kind: "media", identity: value.mediaId, value: { mediaId: value.mediaId, state: value.state,
      publicationState: value.publicationState, accessibilityMetadata: value.accessibilityMetadata ?? null,
      acceptanceHistory: value.acceptanceHistory ?? [], accepted, includedBytes } };
  });
}

function cvProjections(records) {
  const projections = [];
  for (const record of records) {
    const value = record.value.cv ?? record.value;
    const versions = value.versions ?? [];
    const currentId = value.currentVersionId ?? null;
    const ids = new Set(versions.map((version) => version.versionId));
    if (ids.size !== versions.length || currentId !== null && !ids.has(currentId)) fail("REFERENCE_IMPORT_MODEL_CV_CURRENT_INVALID");
    if (currentId !== null && versions.find((version) => version.versionId === currentId)?.state !== "accepted") {
      fail("REFERENCE_IMPORT_MODEL_CV_CURRENT_NOT_ACCEPTED");
    }
    const activations = value.activationHistory ?? [];
    if (currentId === null && versions.some((version) => version.isCurrent === true) ||
        currentId !== null && versions.filter((version) => version.isCurrent === true).length !== 1) {
      fail("REFERENCE_IMPORT_MODEL_CV_CURRENT_FLAG_INVALID");
    }
    if (activations.some((event) => !ids.has(event.versionId)) ||
        currentId !== null && activations.length > 0 && !activations.some((event) => event.versionId === currentId)) {
      fail("REFERENCE_IMPORT_MODEL_CV_HISTORY_INVALID");
    }
    projections.push({ kind: "cv-portfolio", identity: "aggregate", value: { currentVersionId: currentId,
      versions, acceptanceHistory: value.acceptanceHistory ?? [], activationHistory: activations,
      currentVersion: currentId === null ? null : versions.find((version) => version.versionId === currentId) } });
    for (const version of versions) projections.push({ kind: "cv-version", identity: version.versionId,
      value: { mediaId: version.mediaId, versionNumber: version.versionNumber, state: version.state,
        isCurrent: currentId === version.versionId, activated: activations.some((event) => event.versionId === version.versionId) } });
  }
  return projections;
}

function moderationProjections(records) {
  return records.map((record) => {
    const value = record.value;
    if (!stable(value.feedbackId) || !["pending", "approved", "rejected", "suppressed"].includes(value.state)) {
      fail("REFERENCE_IMPORT_MODEL_MODERATION_INVALID");
    }
    if (value.state === "suppressed" && (Object.hasOwn(value, "authorName") || Object.hasOwn(value, "paragraph") ||
        (value.decisionHistory ?? []).some((event) => Object.hasOwn(event, "reason")))) {
      fail("REFERENCE_IMPORT_MODEL_MODERATION_REDACTION_INVALID");
    }
    const history = value.decisionHistory ?? [];
    if (history.some((event, index) => !Number.isSafeInteger(event.sequence) || event.sequence !== index + 1) ||
        history.length > 0 && history.at(-1).decision !== value.state) fail("REFERENCE_IMPORT_MODEL_MODERATION_HISTORY_INVALID");
    return { kind: "moderation-feedback", identity: value.feedbackId, value: { projectId: value.projectId,
      locale: value.locale, state: value.state, textDisposition: value.textDisposition ?? null,
      decisionHistory: value.decisionHistory ?? [], retainedText: value.state === "approved" || value.state === "rejected"
        ? { authorName: value.authorName ?? null, paragraph: value.paragraph ?? null } : null } };
  });
}

function analyticsProjections(records) {
  return records.map((record) => {
    const value = record.value;
    const legacyV1 = record.schemaVersion === "1.0";
    const goal = value.goal;
    if (!stable(goal?.goalId) || !Array.isArray(goal.versions) || !Array.isArray(goal.activationHistory ?? [])) {
      fail("REFERENCE_IMPORT_MODEL_GOAL_INVALID");
    }
    const versionIds = new Set(goal.versions.map((version) => version.versionId));
    const activeVersionId = goal.activeVersionId ?? null;
    const versions = goal.versions;
    const history = goal.activationHistory ?? [];
    if (activeVersionId !== null && !versionIds.has(activeVersionId) ||
        new Set(versions.map((version) => version.versionNumber)).size !== versions.length ||
        versions.some((version) => !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1) ||
        history.some((event, index) => !versionIds.has(event.versionId) || (!legacyV1 &&
          (!Number.isSafeInteger(event.activationSequence) || event.activationSequence !== index + 1))) ||
        activeVersionId !== null && history.length > 0 && !history.some((event) => event.versionId === activeVersionId)) {
      fail("REFERENCE_IMPORT_MODEL_GOAL_POINTER_INVALID");
    }
    const reports = (value.reports ?? []).map((report) => {
      const countDisposition = legacyV1 ? report.sampleState === "sufficient" ? "included" : "withheld" : report.countDisposition ?? null;
      if (countDisposition === "withheld" && (Object.hasOwn(report, "cells") || (!legacyV1 && Object.hasOwn(report, "aggregateCount")))) {
        fail("REFERENCE_IMPORT_MODEL_SUPPRESSED_REPORT_LEAK");
      }
      if (report.goalVersionId !== undefined && !versionIds.has(report.goalVersionId)) fail("REFERENCE_IMPORT_MODEL_REPORT_VERSION_INVALID");
      return { goalVersionId: report.goalVersionId ?? null, sampleState: report.sampleState ?? null,
        countDisposition, ...(legacyV1 && countDisposition === "included" ? { aggregateCount: report.aggregateCount } : {}),
        ...(legacyV1 && countDisposition === "withheld" ? { withheldCount: true } : {}),
        ...(!legacyV1 && countDisposition === "included" && report.cells !== undefined ? { cells: report.cells } : {}) };
    });
    return { kind: "analytics-goal", identity: goal.goalId, value: { goalId: goal.goalId,
      aggregateVersion: goal.aggregateVersion, activeVersionId, versions: goal.versions,
      activationHistory: history, activationSequenceAvailable: !legacyV1, reports } };
  });
}

function configurationProjections(records) {
  return records.map((record) => {
    const value = record.value;
    if (!object(value.profile) || !object(value.globalCta ?? value.projectCta)) fail("REFERENCE_IMPORT_MODEL_CONFIGURATION_INVALID");
    return { kind: "portfolio-configuration", identity: "aggregate", value: {
      profile: value.profile, contactChannels: value.contactChannels ?? [],
      globalCta: value.globalCta ?? value.projectCta, configurationVersion: value.configurationVersion ?? value.version ?? null,
    } };
  });
}

/**
 * Interprets portable records into a small queryable reference model. This is
 * deliberately independent of exporter application types and preserves
 * omitted links as explicit external dependencies instead of inventing rows.
 */
export function buildOwnerExportReferenceModel({ records, manifest, assets }) {
  const byScope = recordMap(records);
  const included = new Set(manifest.includedScopes ?? []);
  const ids = identitiesByScopeAndKind(byScope);
  const { edges: expected, targetKinds, selectedProjectRequired } = expectedEdges(byScope);
  const hasDependencyDeclarations = Array.isArray(manifest.dependencies);
  const declared = new Map((manifest.dependencies ?? []).map((edge) => [
    [edge.sourceScope, edge.sourceId, edge.targetScope, edge.targetId].join("|"), edge,
  ]));
  const legacyPackageWithoutDependencies = manifest.schemaVersion === "1.0" && !hasDependencyDeclarations;
  if (!legacyPackageWithoutDependencies && (expected.size !== declared.size || [...expected.keys()].some((key) => !declared.has(key)))) {
    fail("REFERENCE_IMPORT_MODEL_DEPENDENCY_COVERAGE_INVALID");
  }
  const externalDependencies = [];
  const modelEdges = legacyPackageWithoutDependencies ? expected : declared;
  for (const [key, edge] of modelEdges) {
    const targetKind = targetKinds.get(key);
    if (targetKind === undefined) fail("REFERENCE_IMPORT_MODEL_DEPENDENCY_TARGET_KIND_INVALID");
    const targetExists = hasIdentity(ids, edge.targetScope, targetKind, edge.targetId);
    const targetExistsInScope = hasAnyIdentity(ids, edge.targetScope, edge.targetId);
    if (included.has("portfolio-content") && edge.targetScope === "portfolio-content" && targetKind === "project" &&
        selectedProjectRequired.has(key) && !targetExists) {
      fail("REFERENCE_IMPORT_MODEL_DEPENDENCY_TARGET_KIND_INVALID");
    }
    if (legacyPackageWithoutDependencies) {
      if (included.has(edge.targetScope)) {
        if (!targetExists) fail("REFERENCE_IMPORT_MODEL_DEPENDENCY_TARGET_KIND_INVALID");
      } else {
        externalDependencies.push({ key, ...edge, disposition: "unspecified-legacy",
          reason: "scope-not-selected-inferred", declarationAvailable: false });
      }
      continue;
    }
    if (edge.disposition === "included" && (!included.has(edge.targetScope) || !targetExists)) {
      fail("REFERENCE_IMPORT_MODEL_DEPENDENCY_TARGET_KIND_INVALID");
    }
    if (edge.disposition === "omitted") {
      if (targetExistsInScope || included.has(edge.targetScope) && edge.reason === "scope-not-selected") {
        fail("REFERENCE_IMPORT_MODEL_EXTERNAL_DEPENDENCY_INVALID");
      }
      externalDependencies.push({ key, ...edge });
    }
  }

  const projections = [
    ...contentProjections(byScope.get("portfolio-content") ?? []),
    ...taxonomyProjections(byScope.get("taxonomy") ?? []),
    ...mediaProjections(byScope.get("media-metadata") ?? [], assets),
    ...cvProjections(byScope.get("cv-metadata") ?? []),
    ...moderationProjections(byScope.get("moderation-history") ?? []),
    ...analyticsProjections(byScope.get("analytics-reports") ?? []),
    ...configurationProjections(byScope.get("portfolio-configuration") ?? []),
  ];
  const selectedTaxonomyValues = new Map(projections.filter((projection) => projection.kind === "taxonomy-value")
    .map((projection) => [projection.identity, projection.value]));
  for (const projection of projections.filter((candidate) => candidate.kind === "content-taxonomy-assignment")) {
    const value = selectedTaxonomyValues.get(projection.value.valueId);
    projection.value.selectedTaxonomy = value !== undefined;
    projection.value.state = value?.state ?? null;
    projection.value.currentMeaningId = value?.currentMeaningId ?? null;
  }
  const keys = projections.map((projection) => `${projection.kind}:${projection.identity}`);
  if (new Set(keys).size !== keys.length) fail("REFERENCE_IMPORT_MODEL_PROJECTION_IDENTITY_DUPLICATE");
  return { version: "shipwithali-owner-reference-v1", projections, externalDependencies };
}
