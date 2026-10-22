import test from "node:test";
import assert from "node:assert/strict";
import { REQUIRED_CHECKS, validateBranchProtection } from "../../scripts/verify-branch-protection.mjs";

const baseline = () => ({
  protection: {
    required_status_checks: { strict: true, checks: REQUIRED_CHECKS.map((context) => ({ context, app_id: 15368 })) },
    required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true },
    enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: true },
  }, rulesets: [], effectiveRules: [],
});
test("accepts the applied master protection baseline", () => assert.deepEqual(validateBranchProtection(baseline()), []));
test("rejects missing or wrong-app required checks and weakened review rules", () => {
  const state = baseline(); state.protection.required_status_checks.checks[0].app_id = 0;
  state.protection.required_status_checks.checks.pop();
  state.protection.required_pull_request_reviews.dismiss_stale_reviews = false;
  state.protection.enforce_admins.enabled = false;
  const failures = validateBranchProtection(state);
  assert.ok(failures.includes(`BRANCH_PROTECTION_CHECK_APP_MISMATCH:${REQUIRED_CHECKS[0]}`));
  assert.ok(failures.includes(`BRANCH_PROTECTION_CHECK_MISSING:${REQUIRED_CHECKS.at(-1)}`));
  assert.ok(failures.includes("BRANCH_PROTECTION_STALE_REVIEWS_NOT_DISMISSED"));
  assert.ok(failures.includes("BRANCH_PROTECTION_ADMIN_BYPASS"));
});
test("rejects bypass actors and incomplete effective state", () => {
  assert.ok(validateBranchProtection({ ...baseline(), rulesets: [{ enforcement: "active", bypass_actors: [{ actor_id: 1 }] }] }).includes("BRANCH_PROTECTION_RULESET_BYPASS_PRESENT"));
  assert.deepEqual(validateBranchProtection({ protection: null }), ["BRANCH_PROTECTION_EFFECTIVE_STATE_INCOMPLETE"]);
});
