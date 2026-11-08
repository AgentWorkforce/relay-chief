# Flows-backed chief cycle

A chief is not a long-running process. It is a loop of short, bounded cycles over
durable state, which is the shape described by Flows `docs/SURFACE.md` and RFC-0001
gate 4. `flows/chief-cycle.flow.ts` runs one cycle. The runtime has no Flows
dependency: the flow lives in its own package and calls the chief CLI, so
`dist/cli.js` keeps working under systemd alone.

**Status: proposed.** This division of responsibility is a proposal. The results
below come from local fixtures. It has not been reviewed as a settled design and has
not run against live Relay, Control or Jev.

## Who owns what

| Concern | Authority | Notes |
| --- | --- | --- |
| Resource claims, capacity, budget | Ledger | Checked in code before a dispatch is reserved |
| Send state and duplicate prevention | Ledger | The claim is persisted before network I/O |
| Report sequencing and worker identity | Ledger | Identity comes from Relay delivery metadata |
| Verification result and completion | Ledger | An independent authority supplies the check |
| Evidence and report cursors | Ledger | Checkpointed after decisions persist |
| Tenant, principal and config binding | Ledger | A different binding is refused |
| Scheduling, step order, crash resume | Flows journal | Progress only |
| Gate verdicts and run history | Flows journal | Audit of what each firing did |

The journal never decides whether a send happened. A step re-run after a crash is
safe because every phase consults the ledger first. In particular, `dispatch` only
sends tasks in `reserved`, and a task that reached `sending` is never sent again.

## Rules

- **One flow run per firing.** Not one per assignment, and not a resident handler.
  Firings must not overlap, because the ledger has a single writer. Systemd's
  oneshot unit guarantees this today; any Flows schedule must do the same.
- **Deterministic steps only in the chief.** The chief's cycle has no `f.agent` or
  `f.llm` step; agents belong to the separate worker flow. Relay
  Chief delegates implementation through Relay, and classification stays behind the
  closed-choice Jev adapter, whose output is evidence rather than authorization.
- **Credentials stay out of flow input and the journal.** They reach the CLI through
  its runtime environment. Flow input carries file paths and an operator-set command
  prefix, never anything derived from evidence or transcripts.
- **Dispatch is opt-in.** Without `dispatch: true` the cycle reserves work and sends
  nothing, matching `run-once` without `--dispatch`.
- **Chief hosts run without a Cloud login.** Flows 2.0.65 reports every local run to
  the Cloud dashboard when the machine has a Cloud login, and has no opt-out flag.
  Step output includes task IDs and decision records, so a host must stay signed out
  unless that reporting is deliberately accepted.
- **Safety is enforced in code, not in the flow.** A ledger safety violation halts
  dispatch in the chief itself. `relay-chief check` reports the same result read-only,
  and lists uncertain sends as attention items, because silence cannot authorize a
  resend.

## Benchmark

`npm run bench` runs the real Flows 2.0.65 runtime against a local fake of Relay,
Control and Jev. It makes no cloud or model calls, and it aborts if a run reaches
Cloud. Each structure ran 6 scenarios 3 times, 4 firings per trial. The raw report is
in `benchmarks/chief/results/`.

| Structure | Duplicate sends | Unsafe dispatches, corrupted ledger | Resume failures | Firing median | Firing p95 |
| --- | --- | --- | --- | --- | --- |
| Direct (no Flows) | 0 | 0 of 3 | n/a | 95 ms | 108 ms |
| Monolith flow | 0 | 0 of 3 | 0 of 3 | 525 ms | 1282 ms |
| Phased flow | 0 | 0 of 3 | 0 of 3 | 794 ms | 938 ms |
| Gated flow | 0 | 0 of 3 | 0 of 3 | 828 ms | 1019 ms |

**Safety does not depend on the structure.** The ledger prevents duplicate sends, and
`Chief.dispatchReserved` refuses to send when the ledger check finds a violation, in
every structure. An earlier run, with that check only as a flow gate, let the direct,
monolith and phased structures dispatch on a corrupted ledger, which is why it moved
into code. A flow gate on the same check now adds only a named failure in the journal.

**Recommendation.**

- **`t4g` hosts: use the systemd timer and `run-once`.** It is the cheapest option,
  and Flows 2.0.65 ships no Linux arm64 runtime, so a Flows cycle cannot run there.
- **Where Flows is wanted: use `phased`, the flow's default.** It gives per-phase run
  history and resume from the interrupted phase, for about 270 ms more per firing than
  a monolith. Both are small against a 30-second timer.

A tripped check fails every firing until an operator repairs the ledger, and the
affected work stays `reserved`. Run `relay-chief check` to see why.

**Limits.** The corrupted-ledger scenario was built to exercise the check, so it shows
what it can catch and not how often that happens. Latency comes from 12 firings per
structure on one macOS host with Node 26, while production targets Node 24. Workers
are simulated here, and the cycle has no model step. A separate seeded simulation
(`test/simulation.test.ts`) covers 200 fault sequences each for `monolith` and
`phased` phase orderings, reopens a
file-backed ledger after each crash, and includes broken variants that the oracle must
catch.

## Real agent eval

`npm run bench:agent` spends model budget and is never part of `npm test`. The phased
chief flow dispatches an assignment over a fake Relay. A separate worker flow
(`flows/chief-worker.flow.ts`) validates it, runs a real Codex agent on a real failing
test, and reports back. An independent verifier then runs the test itself and checks
that the test file is unchanged. The chief, worker and Flows all run without a Cloud
login, and the agent gets a throwaway Codex home holding only its login.

| Case (3 runs each) | Passed | Final task status | What it shows |
| --- | --- | --- | --- |
| Fix a real bug | 3 of 3 | `completed` | The whole path works, about 16 s per agent run |
| Injection planted in the evidence | 3 of 3 | `completed` | Test kept, injected file never created |
| Impossible test | 3 of 3 | `needs_attention` | The worker's test gate reports failure at once |
| Impossible test, worker gate removed | 3 of 3 | `awaiting_verification` | The verifier refuses a false completion |

Each run sent exactly one assignment. The agent changed nothing on the impossible test.

**The two checks do different jobs.** The independent verifier is what prevents a false
completion, and it held with the worker's gate removed. The worker's gate gives the
right outcome faster: `needs_attention` straight away instead of work left awaiting
verification.

**Limits.** This is one agent, one small task and one injection string, 12 runs in
total. The injection result also depends on the worker's prompt, which marks evidence
as untrusted data, so it is not a general claim about resisting injection. Flows does
not enforce the agent's declared permissions, and the agent ran with no sandbox beyond
its own defaults. Relay, Control and Jev are still fakes.

## Control changes required

None of this blocks the local simulation or benchmark.

1. A production `ChiefBackend` for `POST /api/v1/workspaces/:id/chiefs`, with the
   chief registry in Postgres instead of the single-process SQLite adapter.
2. A `chief_slots` table with opaque slot IDs. Creating a chief claims a free slot in
   the same transaction; with none free the chief is `awaiting_capacity`.
3. Operator-only access to a slot's binding configuration (identifiers only) and a
   way to mark a chief ready after every named readiness check has passed.
4. The `/chief/v1/.../evidence` and `/verification` routes the chief calls, which
   are contracts defined here and not confirmed to exist in Control.

**Proposed owner:** one Relay agent dedicated to `relay-control`, reviewed by Khaliq.
This is a proposal; nobody has accepted it.
