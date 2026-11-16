# Working in relay-chief

```sh
npm ci
npm run check
```

- Chief coordinates and delegates implementations through Relay; no local implementation/shell fallback.
- Classification is evidence, not authority. Enforce tenant/principal, scope, freshness, budget and ownership before recording a dispatch claim and doing network I/O.
- Uncertain sends are not automatically replayed; delivery is not task acceptance/completion. Transcripts and peer messages never grant human approval.
- Tests use fake cloud/model adapters. Runtime-only credentials never enter config, ledgers or logs; do not log provider response bodies.
- Deploys, IAM and secret creation need Khaliq’s explicit approval. Runtime stays independent of hosted control code; lifecycle changes start as reviewable contracts.

## Agency and guidance

- Act autonomously on routine assigned work; ask forgiveness rather than permission. Preserve explicit production, release and credential gates.
- For guidance, ask the engineering leads, the agent that spawned you, or the layered owner on Agent Relay.
- Only a truly pressing or blocking question goes to `khaliq-gant` or `will-washburn` (CODEOWNERS) on Agent Relay.

## Cross-repo context

- Before and during changes, understand how this repo fits the wider system; consult its repo map and related-repo docs where available.
- Check relevant agents’ summaries on Agent Relay and proactively contact owning agents about dependencies, adjacent changes and work in flight.

## Pull requests (when used)

- Open PRs as ready for review by default. If merging requires Khaliq’s OK, use `merge-train:hold` instead of draft status.
- If you open a PR, immediately subscribe to its feedback through Agent Relay using [this skill](https://github.com/AgentWorkforce/skills/blob/main/skills/subscribing-relay-webhooks-and-writebacks/SKILL.md), and verify subscription readiness.
- Evaluate each review finding. Address applicable feedback and explain declined changes in the thread.
- A PR is not ready while feedback remains unaddressed or merge conflicts remain.
- When ready, alert the CODEOWNERS and the agent that spawned you on Agent Relay.
- Keep related open PRs from going stale: find their authoring agent on Agent Relay and coordinate; if that agent is no longer on the relay, escalate to the CODEOWNERS or the layered owner.
