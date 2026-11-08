# Relay Chief

A persistent project coordinator that delegates through Agent Relay. Customers
will configure a chief through Cloud / relaycontrol / relay-app; a dedicated
host runs the same runtime provided here. The chief observes project evidence,
classifies findings, applies deterministic policy and ownership gates, and sends
bounded assignments to execution agents. It never implements customer changes.

**Current status:** the coordinator core, HTTP adapters, provisioning plan,
worker protocol, accounting ledger and local integration proof are implemented.
The setup UI and authenticated gateway are integrated in the sibling `relay-app`
and `relaycontrol` repos for local validation. Managed host provisioning, deployed
worker integration and live provider qualification remain rollout requirements.
This repo does not deploy infrastructure. See [customer readiness](docs/readiness.md)
and [running the integrated application](docs/local-application.md).

## Run and prove locally

Requires Node 24+ and npm.

```sh
npm ci --ignore-scripts
npm run check
npm run proof
```

The proof opens isolated loopback HTTP services on an ephemeral port and runs
fresh chief and execution-worker processes. It starts a sample project with a
real failing test, presents two related sessions, admits one Relay assignment
while dropping the acknowledgment, restarts the chief, executes the worker and
independently verifies the fixed project. Another restart proves there is no
second dispatch, execution, classification or verification.

The setup, Jev, Relay and verification services in this proof are explicit test
fixtures. The real chief runtime, HTTP clients, SQLite persistence, wire formats,
worker validation and separate processes are exercised. No AWS, Anthropic,
Jev or hosted Relay call occurs. This proof does not qualify deployed services.

## Deterministic coordination

- Tenant, project and repository scope is checked before model inference.
- Jev returns a closed finding and confidence, never a command, assignee or grant.
- Allowed action, evidence freshness, ownership, capacity and reservation budget
  gates run before a durable dispatch intent is created.
- SQLite transactions serialize claims across processes. Work identity is
  repository plus a source-assigned objective key. Explicit resource claims
  prevent competing objectives from owning the same resource.
- The send claim commits before network I/O. There is one POST attempt per task.
  Lost acknowledgments, crashes and unknown outcomes retain ownership. No new ID
  or alternate principal is used to replay the task.
- Relay message delivery, worker acceptance, execution and verified completion
  are separate states. Only the exact assigned agent can report on a task.
- Completion requires the configured authoritative verifier. Worker text or a
  green-looking URL cannot close work. Worker URLs are never fetched by the chief.
- Source cursors and deferred evidence survive restarts. Deferred findings retry
  after 30 seconds while evidence is fresh. Completed classifications are reused;
  changed evidence requires a new immutable source version.

The chief has no shell executor, local implementation harness, repository writer,
agent-spawn tool or AWS client. Runtime credentials should grant only evidence
reads, verification reads and its own Relay identity. Execution agents use their
own capabilities. Human deployment, IAM and secret gates remain in force.

## Runtime integration

The integration ports are exported from `src/index.ts`. The orchestration cycle
is usable as a library; the packaged CLI runs one bounded cycle for a host timer.

```sh
npm run build
node dist/cli.js --help
node dist/cli.js plan examples/setup.json
```

`plan` emits reviewable desired state, allocation tags, credential binding names
and readiness checks. It makes no cloud calls and grants no authority to deploy.

Copy [the example configuration](examples/chief.config.json), replacing identifiers
with provisioned project and Relay identities. Configuration contains no secret
values. A trusted control plane must supply worker identities and derive work and
resource keys from authoritative project data, not arbitrary transcript prose.

Provide these credential bindings at runtime using the platform's existing secret
delivery mechanism; do not commit them or pass them on a command line:

| Binding | Purpose |
| --- | --- |
| `RELAY_AGENT_TOKEN` | Pre-provisioned chief identity, not a workspace admin key |
| `RELAY_BASE_URL` | Optional Relay origin; defaults to `https://cast.agentrelay.com` |
| `TYPESAFE_API_KEY` | Jev classification credential |
| `CHIEF_CONTROL_PLANE_URL` | Authoritative evidence and verification origin |
| `CHIEF_CONTROL_PLANE_TOKEN` | Scoped service credential for that project |

After the adapter routes and execution agents are integrated, an operator can run:

```sh
node dist/cli.js run-once /etc/relay-chief/config.json /var/lib/relay-chief/chief.db --dispatch
node dist/cli.js inspect /var/lib/relay-chief/chief.db
node dist/cli.js check /etc/relay-chief/config.json /var/lib/relay-chief/chief.db
```

`--dispatch` explicitly permits Relay assignments for that cycle; without it a cycle
reserves work and sends nothing. The reference systemd unit runs without it; dispatch needs
`Environment=RELAY_CHIEF_RUN_FLAGS=--dispatch` in a drop-in. The runtime
first reads reports, retries pending verification, scans evidence, and dispatches
reserved work. It does not start a public server. Reference systemd units in
[`deploy/`](deploy/) run it periodically with a private durable state directory.
Installation, credentials and rollout require the existing human approvals.
The reviewed host bootstrap must install Node 24+ at `/usr/bin/node`, create the
`relay-chief` user, and provision the configuration and credential environment
file before installing these reference units. No installer is run by this repo.

Read [the HTTP and worker contracts](docs/contracts.md) before integrating. The
Cloud adapter paths are contracts introduced by this repo, not claims that those
routes already exist in Cloud or relaycontrol.

## Accounting

An application-owned `chiefId` survives host replacement. The provisioning plan
labels host resources with chief, organization, workspace and project IDs. Provider
API identities can be mapped to the same chief and task IDs in the accounting
ledger. `ledger.usage()` accepts idempotent, scoped events from a trusted billing
collector; duplicate identities with conflicting amounts are refused.

Measured cost and dispatch reservations are separate. Unknown costs remain null
and are counted explicitly. Completed tasks retain their full reservation in the
coordination budget; unspent reservations are not inferred from a worker claim.
The budget is a conservative admission limit, not a hard cap on external provider
spend. Execution agents need their own enforced spend limits. Jev's current
classification response does not report token usage or price; its spend cannot
be bounded by these task reservations. Provider billing collectors, AWS cost
allocation activation and budget-window rotation remain rollout integrations.

## Design references

- [Flows authoring contract](https://github.com/AgentWorkforce/flows/blob/main/packages/surface/AUTHORING.md)
- [Flows Jev behavior](https://github.com/AgentWorkforce/flows/blob/main/docs/CLASSIFY.md)
- [Relay DM implementation](https://github.com/AgentWorkforce/relaycast/blob/main/packages/engine/src/routes/dm.ts)
- [Cloud session-analysis ownership](https://github.com/AgentWorkforce/cloud/blob/main/docs/architecture/session-analysis.md)

This implementation uses the inspected Jev and Relay wire contracts directly.
It does not require a Flows installation or claim Flows journal semantics. A
Flows adapter can use these same ports; its permissions and recovery behavior
must be independently qualified before replacing this ledger. See
[the Flows-backed cycle](docs/flows.md) for the proposed split and benchmark results.
