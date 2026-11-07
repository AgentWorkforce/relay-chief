# Customer rollout readiness

The local implementation is a tested integration foundation. Hosted customer use
is not yet qualified. Keep customer onboarding disabled until the remaining
items have concrete evidence.

## Implemented and locally verified

- Closed-choice Jev adapter with bounded evidence, response size, time and safe errors.
- Project, repository, action, freshness and confidence gates before dispatch.
- Transactional durable claims, capacity checks and conservative budget reservations.
- Stable Relay task identities, one-shot send claims and no uncertain-send replay.
- Distinct delivery, acceptance, running, verification and completion states.
- Exact worker identity, task digest, report sequencing and independent verification.
- Tenant-bound SQLite state, cursors, cached classifications and deferred finding retry.
- Source-version integrity and config/principal drift refusal.
- Dedicated chief attribution in an EC2 plan and an idempotent accounting ledger.
- Execution-side protocol validation with no chief implementation fallback.
- Typecheck, tests, build and a multi-process local HTTP integration proof.
- Project/policy/review setup and coordination status in relay-app, connected
  through relaycontrol's existing workspace auth, admin gate and CSRF checks.
- Searchable GitHub multi-selection, automatic naming, immutable repository ID
  claims, access revalidation and Nango proxy adapter tests. Local browser proof
  uses an explicit App fixture; hosted Nango binding remains a qualification gate.
- Local browser validation with a persistent setup registry, actual separate
  execution worker and independent check verification.

## Required before hosted customers

1. **Hosted setup integration:** the local setup UI and authenticated relaycontrol
   gateway exist. Production still needs an admitted managed provider, shared
   control-plane registry and persistent provisioning jobs. The current registry
   is a single-process SQLite adapter; the integrated local provider is development
   code, excluded from the package and not wired into production startup. Supply
   the existing workspace GitHub App binding and Nango client to the repository
   adapter; qualify live connect/callback, App grants and revocation before launch.
2. **Approved infrastructure:** review concrete IAM, network, encryption, secret
   bindings and EC2 bootstrap; obtain Khaliq's approval before applying changes.
   The current provisioning output is a desired-state contract, not executable
   AWS infrastructure. Include disk/host replacement, backups and tested restore.
3. **Execution bridge:** integrate the assignment/report contract with the actual
   Relay-managed native executor, verify session binding and durable deduplication,
   enforce worker resource and spending limits, and supply real execution capacity.
4. **Live qualification:** verify deployed Relay DM metadata/idempotency behavior,
   Jev authentication and classification, actual project evidence authorization,
   and authoritative completion checks for the chosen customer workflow.
5. **Operational recovery:** implement provider-fenced reconciliation, authenticated
   pause/cancel controls, alerts for stuck work, audit retention and scale limits.
   Local silence cannot authorize a duplicate dispatch.
6. **Billing:** connect the trusted Anthropic/Jev/AWS collectors, dedicated provider
   identity mapping, allocation tags, billing periods and customer billing rules.
   Verify unmetered and delegated costs stay visible and cannot evade limits.
7. **Public distribution:** confirm the intended OSS license and release process;
   the package remains private/unpublished pending that decision.

## Local proof boundary

`npm run proof` uses actual HTTP serialization and chief/worker subprocesses with
SQLite on disk and real failing/passing sample-project tests. Its external setup,
Relay, Jev and control-plane services are controlled fixtures. They prove the
local contracts and failure behavior, not deployed integration or EC2 behavior.
All test inputs are synthetic; no customer data or live credentials are used.
