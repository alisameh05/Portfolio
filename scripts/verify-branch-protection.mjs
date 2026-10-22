#!/usr/bin/env node
// Verify effective master protection against the recorded applied configuration.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const INTENT = JSON.parse(readFileSync(new URL("../docs/branch-protection-master.json", import.meta.url), "utf8"));
export const REQUIRED_CHECKS = Object.freeze(INTENT.requiredChecks.map((entry) => entry.context));

export function validateBranchProtection({ protection, rulesets = [], effectiveRules = [] }) {
  const failures = [];
  if (!protection || !Array.isArray(rulesets) || !Array.isArray(effectiveRules)) return ["BRANCH_PROTECTION_EFFECTIVE_STATE_INCOMPLETE"];
  const checks = protection.required_status_checks;
  if (!checks || checks.strict !== true || !Array.isArray(checks.checks)) failures.push("BRANCH_PROTECTION_STATUS_CHECKS_INVALID");
  else {
    for (const context of REQUIRED_CHECKS) {
      const found = checks.checks.find((c) => c?.context === context);
      if (!found) failures.push(`BRANCH_PROTECTION_CHECK_MISSING:${context}`);
      else if (found.app_id !== INTENT.requiredChecks.find((entry) => entry.context === context)?.app_id) failures.push(`BRANCH_PROTECTION_CHECK_APP_MISMATCH:${context}`);
    }
  }
  const reviews = protection.required_pull_request_reviews;
  if (protection.enforce_admins?.enabled !== INTENT.enforceAdmins) failures.push("BRANCH_PROTECTION_ADMIN_BYPASS");
  if ((reviews?.required_approving_review_count ?? 0) < INTENT.minHumanApprovals) failures.push("BRANCH_PROTECTION_HUMAN_APPROVALS_MISSING");
  if (reviews?.dismiss_stale_reviews !== INTENT.dismissStaleReviews) failures.push("BRANCH_PROTECTION_STALE_REVIEWS_NOT_DISMISSED");
  if (reviews?.require_last_push_approval !== INTENT.requireLastPushApproval) failures.push("BRANCH_PROTECTION_LAST_PUSH_APPROVAL_MISSING");
  if (protection.allow_force_pushes?.enabled !== INTENT.allowForcePushes) failures.push("BRANCH_PROTECTION_FORCE_PUSH_ALLOWED_OR_UNKNOWN");
  if (protection.allow_deletions?.enabled !== INTENT.allowDeletions) failures.push("BRANCH_PROTECTION_DELETION_ALLOWED_OR_UNKNOWN");
  if (protection.required_conversation_resolution?.enabled !== INTENT.requiredConversationResolution) failures.push("BRANCH_PROTECTION_CONVERSATION_RESOLUTION_MISSING");
  // Detect ruleset bypass actors and rules that weaken required protections.
  for (const ruleset of rulesets) {
    if (ruleset?.enforcement !== "disabled" && Array.isArray(ruleset?.bypass_actors) && ruleset.bypass_actors.length > 0) failures.push("BRANCH_PROTECTION_RULESET_BYPASS_PRESENT");
  }
  for (const rule of effectiveRules) {
    if (rule?.type === "pull_request" && (rule.parameters?.required_approving_review_count ?? 0) < 1) failures.push("BRANCH_PROTECTION_EFFECTIVE_APPROVAL_RULE_WEAK");
    if (rule?.type === "required_status_checks") {
      const names = rule.parameters?.required_status_checks?.map((x) => x.context) ?? [];
      for (const name of REQUIRED_CHECKS) if (!names.includes(name)) failures.push(`BRANCH_PROTECTION_EFFECTIVE_CHECK_MISSING:${name}`);
    }
  }
  return [...new Set(failures)];
}

function ghApi(path) {
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}
function ghApiAll(path) {
  const pages = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error("UNEXPECTED_PAGINATED_API_RESPONSE");
  return pages.flat();
}
async function main() {
  const fixturePath = process.argv[2];
  let state;
  if (fixturePath) state = JSON.parse(readFileSync(fixturePath, "utf8"));
  else {
    const repo = process.env.GITHUB_REPOSITORY;
    const inferredRepo = repo || execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const root = `repos/${inferredRepo}`;
    const protection = ghApi(`${root}/branches/master/protection`);
    const rulesets = ghApiAll(`${root}/rulesets?includes_parents=true&per_page=100`);
    const effectiveRules = ghApiAll(`${root}/rules/branches/master?per_page=100`);
    state = { protection, rulesets, effectiveRules };
  }
  const failures = validateBranchProtection(state);
  if (failures.length) { for (const failure of failures) console.error(`✗ ${failure}`); process.exitCode = 1; }
  else console.log("✓ Effective master branch protection matches the required baseline.");
}
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  try { await main(); } catch (error) { console.error(`✗ BRANCH_PROTECTION_UNVERIFIED:${String(error?.message ?? "unknown").replace(/[^A-Za-z0-9 ._-]/gu, "_")}`); process.exitCode = 1; }
}
