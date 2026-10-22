import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TRUSTED_BOT, fetchAllPages, validateCodexReview } from "../../scripts/check-codex-review.mjs";

const sha = "a".repeat(40);
const pr = { state: "open", base: { ref: "master" }, head: { sha } };
const bot = { login: TRUSTED_BOT.login, id: TRUSTED_BOT.id, type: "Bot" };
const app = { id: TRUSTED_BOT.appId, slug: TRUSTED_BOT.appSlug };
const review = { user: bot, commit_id: sha, state: "COMMENTED", submitted_at: "2026-10-21T23:59:00Z" };
const comment = { user: bot, performed_via_github_app: app, created_at: "2026-10-22T00:00:00Z", body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","status":"completed","has_any_findings":false,"has_unresolved_findings":false}} -->` };
const valid = () => ({ pr, reviews: [review], issueComments: [comment], reviewThreads: [] });

test("accepts only a completed current-head review and metadata from the trusted Codex app", () => {
  assert.equal(validateCodexReview(valid()).ok, true);
});
test("accepts a clean current-head summary attestation without a formal review object", () => {
  const input = valid();
  input.reviews = [];
  input.issueComments[0] = { ...comment, body: comment.body.replace('"has_any_findings":false', '"has_any_findings":true').replace('"has_unresolved_findings":false', '"has_unresolved_findings":false') };
  assert.equal(validateCodexReview(input).ok, true);
});
test("rejects human/self-authored metadata and review", () => {
  const input = valid(); input.issueComments[0] = { ...comment, user: { login: "alice", id: 1, type: "User" } };
  assert.ok(validateCodexReview(input).errors.includes("CURRENT_HEAD_CODEX_METADATA_MISSING"));
  const other = valid(); other.reviews[0] = { ...review, user: { login: "alice", id: 1, type: "User" } };
  other.issueComments = [];
  assert.ok(validateCodexReview(other).errors.includes("CURRENT_HEAD_CODEX_METADATA_MISSING"));
  const absent = valid(); absent.issueComments = [];
  assert.ok(validateCodexReview(absent).errors.includes("CURRENT_HEAD_CODEX_METADATA_MISSING"));
});
test("rejects stale heads, incomplete findings, unresolved threads, and absent state", () => {
  const stale = valid(); stale.reviews[0] = { ...review, commit_id: "b".repeat(40) };
  stale.issueComments[0] = { ...comment, body: comment.body.replace(sha, "b".repeat(40)) };
  assert.ok(validateCodexReview(stale).errors.includes("CURRENT_HEAD_CODEX_METADATA_MISSING"));
  const unresolved = valid(); unresolved.issueComments[0] = { ...comment, body: comment.body.replace('"has_unresolved_findings":false', '"has_unresolved_findings":true') };
  assert.ok(validateCodexReview(unresolved).errors.includes("CODEX_FINDINGS_UNRESOLVED"));
  assert.ok(validateCodexReview({ ...valid(), reviewThreads: [{ isResolved: false }] }).errors.includes("UNRESOLVED_REVIEW_THREADS"));
  assert.ok(validateCodexReview({ ...valid(), expectedHeadSha: "b".repeat(40) }).errors.includes("PR_HEAD_DIFFERS_FROM_EVENT_HEAD"));
  const contradictory = valid(); contradictory.reviews[0] = { ...review, state: "DISMISSED" };
  assert.ok(validateCodexReview(contradictory).errors.includes("CURRENT_HEAD_CODEX_REVIEW_CONTRADICTORY"));
  assert.ok(validateCodexReview({ pr, reviews: [], issueComments: [], reviewThreads: [] }).errors.length > 0);
  assert.deepEqual(validateCodexReview({ pr, reviews: null, issueComments: [], reviewThreads: [] }).errors, ["REVIEW_STATE_INCOMPLETE"]);
});
test("loads every review-state page and fails closed when pagination fails", async () => {
  const calls = [];
  const rows = await fetchAllPages("https://api.github.test/reviews", "unused", async (url) => {
    calls.push(url);
    return calls.length === 1 ? Array.from({ length: 100 }, (_, i) => i) : [100];
  });
  assert.equal(rows.length, 101);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /page=2/u);
  await assert.rejects(fetchAllPages("https://api.github.test/reviews", "unused", async () => { throw new Error("API failure"); }), /API failure/u);
});
test("uses the latest edited current-head metadata comment", () => {
  const input = valid();
  input.issueComments.push({ ...comment, updated_at: "2026-10-22T00:01:00Z", body: comment.body.replace('"status":"completed"', '"status":"in_progress"') });
  assert.ok(validateCodexReview(input).errors.includes("CODEX_REVIEW_INCOMPLETE"));
});
test("workflow runs the stable check on every master PR head with pinned actions and read-only permissions", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/codex-review.yml", import.meta.url), "utf8");
  assert.match(workflow, /^  pull_request:\r?$/mu);
  assert.match(workflow, /branches:\s*\[master\]/u);
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(workflow, /name:\s*Codex review/u);
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/u);
  assert.match(workflow, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/u);
  assert.match(workflow, /pull-requests:\s*read/u);
  assert.match(workflow, /issues:\s*read/u);
  assert.doesNotMatch(workflow, /pull_request_target|contents:\s*write|issue_comment/u);
});
