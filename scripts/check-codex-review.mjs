#!/usr/bin/env node
// Fail-closed required check for an independent Codex review of the current PR head.
import { fileURLToPath } from "node:url";

export const TRUSTED_BOT = Object.freeze({ login: "chatgpt-codex-connector[bot]", id: 199175422, appId: 1144995, appSlug: "chatgpt-codex-connector" });
const MARKER = /<!--\s*codex-review-state:v1\s+(\{[^]*?\})\s*-->/gu;

function parseMarker(body) {
  let latest = null;
  for (const match of body.matchAll(MARKER)) {
    try { latest = JSON.parse(match[1]); } catch { return null; }
  }
  return latest;
}

export function validateCodexReview({ pr, reviews, issueComments, reviewThreads, expectedHeadSha }) {
  const errors = [];
  const head = pr?.head?.sha;
  if (!head || pr?.base?.ref !== "master" || pr?.state !== "open") return { ok: false, errors: ["PR_NOT_OPEN_FOR_MASTER"] };
  if (expectedHeadSha && expectedHeadSha !== head) return { ok: false, errors: ["PR_HEAD_DIFFERS_FROM_EVENT_HEAD"] };
  if (!Array.isArray(reviews) || !Array.isArray(issueComments) || !Array.isArray(reviewThreads)) return { ok: false, errors: ["REVIEW_STATE_INCOMPLETE"] };
  const bot = (u) => u?.login === TRUSTED_BOT.login && u?.id === TRUSTED_BOT.id && u?.type === "Bot";
  const app = (a) => a?.id === TRUSTED_BOT.appId && a?.slug === TRUSTED_BOT.appSlug;
  const metadata = issueComments.map((c) => ({ comment: c, state: typeof c.body === "string" ? parseMarker(c.body) : null }))
    .filter(({ comment, state }) => bot(comment.user) && app(comment.performed_via_github_app) && state?.code_review?.commit_sha === head)
    .sort((a, b) => Date.parse(b.comment.updated_at ?? b.comment.created_at) - Date.parse(a.comment.updated_at ?? a.comment.created_at))[0];
  if (!metadata) errors.push("CURRENT_HEAD_CODEX_METADATA_MISSING");
  else {
    const state = metadata.state.code_review;
    if (state.status !== "completed") errors.push("CODEX_REVIEW_INCOMPLETE");
    if (typeof state.has_any_findings !== "boolean" || typeof state.has_unresolved_findings !== "boolean" || state.has_unresolved_findings !== false) errors.push("CODEX_FINDINGS_UNRESOLVED");
    if (!Number.isFinite(Date.parse(metadata.comment.updated_at ?? metadata.comment.created_at))) errors.push("CODEX_METADATA_TIMESTAMP_INVALID");
  }
  const currentReviews = reviews.filter((r) => bot(r.user) && r.commit_id === head)
    .sort((a, b) => Date.parse(b.submitted_at ?? 0) - Date.parse(a.submitted_at ?? 0));
  if (currentReviews.length > 0 && currentReviews[0].state !== "COMMENTED") errors.push("CURRENT_HEAD_CODEX_REVIEW_CONTRADICTORY");
  else if (currentReviews.length > 0) {
    const reviewedAt = Date.parse(currentReviews[0].submitted_at ?? "");
    if (!Number.isFinite(reviewedAt)) errors.push("CODEX_REVIEW_TIMESTAMP_INVALID");
    else if (metadata && Date.parse(metadata.comment.updated_at ?? metadata.comment.created_at) < reviewedAt) errors.push("CODEX_METADATA_PRECEDES_LATEST_REVIEW");
  }
  if (reviewThreads.some((t) => t?.isResolved !== true)) errors.push("UNRESOLVED_REVIEW_THREADS");
  return { ok: errors.length === 0, errors, headSha: head };
}

async function api(url, token) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response.json();
}
export async function fetchAllPages(url, token, fetchJson = api) {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await fetchJson(`${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`, token);
    if (!Array.isArray(batch)) throw new Error("Unexpected paginated API response");
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  throw new Error("Pagination limit exceeded");
}
async function allReviewThreads(repo, prNumber, token) {
  const [owner, name] = repo.split("/");
  const nodes = [];
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const response = await fetch("https://api.github.com/graphql", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query: `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{isResolved}}}}}`, variables: { owner, name, number: Number(prNumber), cursor } }) });
    if (!response.ok) throw new Error(`GraphQL ${response.status}`);
    const result = await response.json();
    const connection = result.data?.repository?.pullRequest?.reviewThreads;
    if (result.errors?.length || !connection) throw new Error("Review thread state incomplete");
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return nodes;
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) throw new Error("Review thread pagination invalid");
    cursor = connection.pageInfo.endCursor;
  }
  throw new Error("Review thread pagination limit exceeded");
}
async function verifyPr(repo, prNumber, token) {
  const root = `https://api.github.com/repos/${repo}`;
  const before = await api(`${root}/pulls/${prNumber}`, token);
  const [reviews, issueComments, reviewThreads] = await Promise.all([
    fetchAllPages(`${root}/pulls/${prNumber}/reviews`, token),
    fetchAllPages(`${root}/issues/${prNumber}/comments`, token),
    allReviewThreads(repo, prNumber, token),
  ]);
  const pr = await api(`${root}/pulls/${prNumber}`, token);
  if (before?.head?.sha !== pr?.head?.sha) return { ok: false, errors: ["PR_HEAD_CHANGED_DURING_REVIEW_READ"] };
  return validateCodexReview({ pr, reviews, issueComments, reviewThreads, expectedHeadSha: process.env.EXPECTED_HEAD_SHA });
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  if (!token || !repo) { console.error("CODEX_REVIEW_API_FAILURE:required inputs missing"); process.exit(1); }
  try {
    if (!/^\d+$/u.test(prNumber ?? "")) throw new Error("PR_NUMBER_INVALID");
    if (!/^[0-9a-f]{40}$/u.test(process.env.EXPECTED_HEAD_SHA ?? "")) throw new Error("EXPECTED_HEAD_SHA_INVALID");
    const result = await verifyPr(repo, prNumber, token);
    if (!result.ok) { for (const error of result.errors) console.error(`CODEX_REVIEW_REQUIRED:${error}`); process.exit(1); }
    console.log(`Codex review confirmed for PR ${prNumber} at ${result.headSha}.`);
  } catch (error) { console.error(`CODEX_REVIEW_API_FAILURE:${String(error?.message ?? "unknown").replace(/[^A-Za-z0-9 ._-]/gu, "_")}`); process.exit(1); }
}
