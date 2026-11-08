# Hosted adapter and worker contracts

These contracts are implemented by the chief's clients. `relaychief-control` must
implement the server side and mount them behind their existing tenant auth.
They are not public, unauthenticated routes. There is no host-admin API here.

## Configuration and lifecycle

Use `chiefConfigSchema` for non-secret configuration and `provisionPlan()` for
desired host state. The control plane derives identity from authenticated customer
context; it must not accept arbitrary organization/workspace IDs from a browser.
Bind setup idempotency keys to authenticated tenant plus request ID, and reject
changed request digests for a reused key. Do not allocate a second host on retry.

Persist one chief per project in the hosted registry. Provision asynchronously,
report setup progress, and mark ready only after every named readiness check has
actually passed. Installing binaries or creating an instance does not establish
worker capacity, authorization, verification availability or readiness.

A configuration has a positive integer `revision`. Every change must increase it;
older revisions and changed content under an existing revision are refused.
A ledger belongs to exactly one organization, workspace, project, chief and Relay
caller. A different binding is refused. Trusted configuration activation replaces
the active configuration digest; old instances cannot reserve or send new work.
Unsent work under an old configuration is canceled on dispatch and its claim is
released. Previously sent work retains its claim and original assignee identity.

## Evidence source

`GET /chief/v1/projects/:projectId/evidence?limit=100&cursor=...`

Authorization: `Bearer <scoped service credential>`.

Return an unwrapped object:

```json
{
  "cursor": "opaque-next-page",
  "evidence": [{
    "sourceId": "project-sessions-v1",
    "sessionId": "session-123",
    "version": "immutable-source-version",
    "organizationId": "org-123",
    "workspaceId": "workspace-123",
    "projectId": "project-123",
    "repository": "owner/repo",
    "workKey": "issue-42-objective-1",
    "resourceKeys": ["issue-42", "src/auth.ts"],
    "observedAt": 1800000000000,
    "summary": "Redacted project evidence",
    "references": ["https://github.com/owner/repo/issues/42"]
  }]
}
```

The source must enforce project authorization and redact secrets before returning
data. Work and resource keys are trusted adapter output, derived from structured
issue, PR, branch and repository relationships. Do not let Jev mint keys or treat
semantic similarity as proof of conflict. If identity cannot be derived, surface
the ambiguity for inspection instead of inventing ownership.

Return at most 100 records. Each page's cursor must allow continuation without
missing updates. Repeating a source/session/version with different contents is a
contract failure. Repeated evidence is safe. An empty page still returns a cursor.
The caller persists decisions and deferred evidence before checkpointing it.

## Assignment registration

`PUT /chief/v1/projects/:projectId/tasks/:taskId/assignment`

Use the same scoped control-plane credential. The body is
`{ "assignmentDigest": "...", "assignment": { ... } }`, where the digest is `hash()` of
the exact stored `Assignment`. An identical replay succeeds; a different digest for the
same task is refused and never overwrites. Success is a 200 or 201 with a JSON body. A
registered assignment whose task is later canceled stays on record and has no effect,
because verification only runs against a worker report.

The chief registers before it claims the send. A registration failure leaves the task
`reserved` with nothing sent, and a later cycle retries. Registering first means a
registration failure can never strand a task in `sending`. Failures after the claim
are different: a crash or lost response during the send leaves `sending` or `uncertain`,
and those are never retried.

## Relay assignments

The client resolves `GET /v1/agent`, pins origin/workspace/caller, then issues one
`POST /v1/dm` with an agent token, `Idempotency-Key: <taskId>`, `mode: wait`, and the
configured `address: agent@machine`. Metadata carries `chief_assignment` and
`assignment_digest`. `Assignment` in `src/contracts.ts` is the exact payload.

The task ID and digest bind the assignee, action, objective, resources, project,
policy version, evidence snapshot, reservation and acceptance criteria. The DM
does not grant deployment, IAM or secret authority. A message receipt is not a
worker task receipt. The protocol deliberately does not silently convert generic
DMs into native stdin submissions.

The execution agent's Relay integration must call `readAssignment()` with sender
and recipient identities from authenticated delivery metadata and its own policy.
It must durably deduplicate task IDs and matching payload digests before starting
native execution. A crash after accepting work needs the executor's native receipt
reconciliation; do not rerun implementation simply because a DM is replayed.
The helper validates assignments; it does not supply a worker harness or resource
enforcement. Existing agents need this bridge before customer use.

## Worker reports

Send reports back through Relay DMs in metadata `chief_report`:

```json
{
  "protocol": "relay-chief.report.v1",
  "taskId": "chief-task-id",
  "assignmentDigest": "64-character-sha256",
  "sequence": 1,
  "state": "accepted",
  "artifactRefs": []
}
```

States are `accepted`, `running`, `completed`, `failed`. Sequence numbers increase
per task. Repeating the same sequence and payload is safe; conflicting reuse is
refused. Sender ID and workspace are read from Relay, never the report body.
Only the originally assigned agent can report; changed configuration does not
allow another agent to take ownership of an in-flight task.

The client reads authorized 1:1 conversations and pages messages both after its
durable cursor and before the oldest message in a full page, processing oldest
first. Invalid reports are durably quarantined as hashed decision records.
Unexpected runtime/storage failures do not advance the cursor. Polling currently
fails explicitly at 100 conversations or more than 1,000 new messages in one
conversation; these limits need qualification for the intended customer scale.

## Authoritative completion verification

`GET /chief/v1/projects/:projectId/tasks/:taskId/verification?sequence=N`

Use the same scoped control-plane credential. Return an unwrapped object:

```json
{
  "taskId": "chief-task-id",
  "assignmentDigest": "64-character-sha256",
  "sequence": 3,
  "ok": true,
  "checks": ["repository@revision:required-check-id"]
}
```

The authority must know the original immutable assignment and independently verify
its acceptance criteria against authoritative repository/CI state. Bind checks to
the exact revision and current task, not a reusable green status. `ok: true` needs
at least one check. A worker's completion claim alone is insufficient.

Mismatched identity, missing checks, unavailable verification or `ok: false` leaves
work awaiting verification and retains its resource claims. A later cycle can
retry verification without another worker report or execution.

## Recovery and reservations

`reserved` is unsent work. `sending` means a POST may have happened. `uncertain`
means its outcome could not be confirmed. Neither state permits another POST.
Authenticated worker reports can reconcile either state. `needs_attention` retains
claims after a worker failure; it does not assume the execution has stopped.

There is no automatic claim expiry or administrative resend command. Silence,
HTTP 404, a missing conversation or a timeout is not proof that work never ran.
Recovery without worker receipts needs a provider-supported, durable execution
fence and an authenticated operator workflow; this is a rollout requirement.
Do not manually delete rows to make a stuck task run again.

Task reservations bound admission and remain committed on verified completion.
They do not measure billed costs or enforce remote executor spending. Budgets are
lifetime per-chief totals in this version; configure a deliberate policy change
for increased allocation. Automatic billing periods and refunds are not inferred.

`ledger.usage()` accepts trusted accounting events with event ID, chief/workspace,
optional task, actor, provider, provider identity ID, time, nullable microdollar
cost and nullable token counts. Use provider identity IDs, never key values.
Keep provider admin/analytics credentials in the hosted billing collector.
