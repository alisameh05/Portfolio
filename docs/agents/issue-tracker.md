# Issue Tracker: Local Markdown

This repository has no configured remote issue tracker. Issues and specifications live as Markdown files in `.scratch/`.

## Conventions

- One feature or effort per directory: `.scratch/<feature-slug>/`.
- The feature specification is `.scratch/<feature-slug>/spec.md`.
- Implementation issues use one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`; do not combine tickets into one file.
- Triage state is recorded as a `Status:` line near the top of each issue file. Use the vocabulary in `docs/agents/triage-labels.md`.
- Comments and conversation history are appended under a `## Comments` heading.

## Skill mappings

- When a skill says to publish to the issue tracker, create or update the appropriate file under `.scratch/<feature-slug>/`.
- When a skill says to fetch a ticket, read the referenced Markdown path.

## Wayfinding

- Map: `.scratch/<effort>/map.md`.
- Child ticket: `.scratch/<effort>/issues/NN-<slug>.md` with a `Type:` line containing `research`, `prototype`, `grilling`, or `task`.
- Blocking: use a `Blocked by: NN, NN` line near the top of the ticket. A ticket is unblocked when every listed file is resolved.
- Frontier: choose the first numbered open, unblocked, unclaimed ticket.
- Claim: set `Status: claimed` and save before starting work.
- Resolve: append the answer under `## Answer`, set `Status: resolved`, and add a context pointer to the map's Decisions-so-far section.
