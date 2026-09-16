# Issue Tracker: GitHub Issues

GitHub Issues in this repository are the authoritative tracker for specifications, implementation tickets, triage state, blocking relationships, and discussion.

Do not silently publish tracker artifacts under `.scratch/`. If GitHub authentication, repository access, or issue permissions are unavailable, stop publishing, preserve the draft in the conversation, and report the exact access blocker. Local Markdown is used only when the user explicitly requests an offline artifact.

## Conventions

- Publish one specification as one GitHub issue. Use a descriptive title and apply the `spec` label together with the appropriate triage label.
- Publish one implementation ticket per GitHub issue. Never combine several tickets into one issue.
- Link every implementation ticket to its specification under a `## Parent` heading.
- Record dependencies under `## Blocked by` using GitHub issue references. Use GitHub's native blocking relationship when the available tooling supports it; otherwise the issue references in the body are authoritative.
- Publish blockers before the tickets that depend on them so references can use real issue numbers.
- Apply exactly one canonical triage label from `docs/agents/triage-labels.md` unless a workflow explicitly requires a Wayfinding execution state.
- Put discussion, progress, evidence, and decisions in GitHub issue comments. Edit the issue body only when its durable scope or acceptance criteria change.
- Do not close or rewrite a parent specification when creating, updating, or resolving child tickets.
- Do not assign an issue to a person unless the user names the assignee or the acting GitHub account explicitly claims it.

## Skill mappings

- When a skill says to publish a specification to the issue tracker, create or update its GitHub issue and return the issue reference and URL.
- When a skill says to publish tickets, create one GitHub issue per approved ticket in dependency order, attach the parent reference, blocking relationships, and `ready-for-agent` label, then return all issue references and URLs.
- When a skill says to fetch a specification or ticket, read the full GitHub issue body and relevant comments before acting.
- When a skill says to comment, append a GitHub issue comment rather than creating a local conversation log.

## Wayfinding

- Map: one parent GitHub issue describing the effort, current frontier, and decisions so far.
- Child ticket: one linked GitHub issue whose body declares `Type: research`, `prototype`, `grilling`, or `task`.
- Blocking: use native blocking relationships when possible and always include issue references under `## Blocked by`. A ticket is unblocked when every referenced blocker is closed as completed.
- Frontier: choose the lowest-numbered open, unblocked, and unclaimed child issue.
- Claim: assign the issue to the acting GitHub user when known and add the `claimed` execution label. If self-assignment is unavailable, add a claim comment before starting.
- Resolve: post the answer and validation evidence as a comment, add a decision pointer to the map issue, apply the `resolved` execution label when available, and close the child issue as completed.

## Access and setup

- The repository's `origin` remote identifies the GitHub repository to use unless the user explicitly selects another repository.
- Verify GitHub authentication and issue permissions before the first write.
- Ensure the canonical triage labels exist. Create missing labels when permissions allow; otherwise report the missing labels as a publishing blocker.
- A failed GitHub write must not be represented as a published issue and must not be replaced automatically with a `.scratch/` file.
