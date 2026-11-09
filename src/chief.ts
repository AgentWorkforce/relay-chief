import type { AssignmentRegistry, AuthenticatedReport, ChiefConfig, Classifier, CompletionVerifier, Decision, EvidenceSource, RelayTransport, Task } from './contracts.js';
import { chiefConfigSchema, classificationSchema, evidenceSchema, hash, relayWorkspaceOf, reportSchema } from './contracts.js';
import { Ledger } from './ledger.js';
import { checkLedger } from './invariants.js';
import { evaluate } from './policy.js';

/** This runtime has no implementation agent, shell executor, repository writer or cloud client. */
export class Chief {
  readonly config: ChiefConfig;
  readonly ledger: Ledger;
  private ports: {
    classifier: Classifier;
    relay: RelayTransport;
    verifier: CompletionVerifier;
    /** When set, an assignment must be registered before it can be claimed or sent. */
    assignments?: AssignmentRegistry;
    now?: () => number;
  };
  constructor(config: ChiefConfig, ledger: Ledger, ports: Chief['ports']) {
    this.ledger = ledger;
    this.ports = ports;
    this.config = chiefConfigSchema.parse(config);
    ledger.configure(this.config);
  }
  private now(): number { return (this.ports.now ?? Date.now)(); }
  async observe(raw: unknown): Promise<Decision> {
    const evidence = evidenceSchema.parse(raw);
    if (!this.ledger.active(this.config)) return this.ledger.record({ evidenceDigest: hash(evidence),
      kind: 'uncertain', outcome: 'deferred', reason: 'configuration_changed' }, this.now());
    const preflight = evaluate(this.config, evidence, { kind: 'no_action', confidence: 1 }, this.now());
    if (preflight) {
      this.ledger.finish(hash(evidence));
      return this.ledger.record({ evidenceDigest: hash(evidence), kind: 'uncertain', outcome: 'deferred', reason: preflight }, this.now());
    }
    let classification = this.ledger.remember(evidence);
    if (!classification) {
      try { classification = classificationSchema.parse(await this.ports.classifier.classify(evidence)); }
      catch {
        this.ledger.defer(hash(evidence), this.now());
        return this.ledger.record({ evidenceDigest: hash(evidence), kind: 'uncertain', outcome: 'deferred', reason: 'classifier_unavailable' }, this.now());
      }
      classification = this.ledger.classify(evidence, classification);
    }
    return this.ledger.reserve(this.config, evidence, classification, this.now());
  }
  async scan(source: EvidenceSource): Promise<Decision[]> {
    const previous = this.ledger.cursor(source.id);
    const page = await source.read(previous);
    if (!page.cursor || page.evidence.length > 100) throw new Error('source_page_invalid');
    // Validate the complete page before classification or task reservation.
    const evidence = page.evidence.map(value => evidenceSchema.parse(value));
    if (evidence.some(value => value.sourceId !== source.id)) throw new Error('source_identity_mismatch');
    const decisions: Decision[] = [];
    const incoming = new Set(evidence.map(hash));
    for (const deferred of this.ledger.pending(this.now())) if (!incoming.has(hash(deferred))) decisions.push(await this.observe(deferred));
    for (const value of evidence) decisions.push(await this.observe(value));
    this.ledger.checkpoint(source.id, previous, page.cursor);
    return decisions;
  }
  async dispatch(id: string): Promise<Task> {
    const identity = await this.ports.relay.identity();
    if (identity.callerId !== this.config.relayCallerId || identity.workspaceId !== relayWorkspaceOf(this.config)) throw new Error('relay_scope_mismatch');
    this.ledger.bindRelay(identity);
    // Before the claim: registration is idempotent, so a failure leaves the task reserved and safe to retry.
    const pending = this.ledger.task(id);
    if (this.ports.assignments && pending.status === 'reserved') {
      try { await this.ports.assignments.register(pending.assignment, pending.digest); }
      catch {
        this.ledger.recordOnce({ evidenceDigest: pending.assignment.evidenceDigest, kind: 'uncertain', outcome: 'deferred',
          reason: 'assignment_registration_failed', taskId: id }, this.now());
        return pending;
      }
    }
    const claimed = this.ledger.claimSend(this.config, id, this.now());
    if (claimed) {
      try {
        const receipt = await this.ports.relay.send(claimed.assignment, claimed.digest);
        if (!receipt.messageId.trim()) throw new Error('relay_receipt_invalid');
        this.ledger.delivery(id, receipt.messageId, this.now());
      } catch {
        // Any outcome after entering the transport is uncertain. Never retry the send.
        this.ledger.delivery(id, undefined, this.now());
      }
    }
    return this.ledger.task(id);
  }
  async dispatchReserved(): Promise<Task[]> {
    // Fail closed in code, so every path is protected and not only a flow with gates.
    if (!checkLedger(this.ledger, this.config).ok) throw new Error('dispatch_halted');
    const tasks: Task[] = [];
    for (const task of this.ledger.tasks()) if (task.status === 'reserved') tasks.push(await this.dispatch(task.id));
    return tasks;
  }
  async receive(raw: AuthenticatedReport): Promise<Task> {
    const event = { workspaceId: raw.workspaceId, agentId: raw.agentId, report: reportSchema.parse(raw.report) };
    const task = this.ledger.report(event, this.now());
    return task.status === 'awaiting_verification' ? this.verify(task.id) : task;
  }
  async verify(id: string): Promise<Task> {
    const task = this.ledger.task(id);
    if (task.status !== 'awaiting_verification' || !task.report) return task;
    try {
      const verification = await this.ports.verifier.verify(task.assignment, task.report);
      if (typeof verification.ok !== 'boolean' || !Array.isArray(verification.checks) ||
          verification.checks.some(check => typeof check !== 'string' || !check.trim() || check.length > 500)) throw new Error('verification_invalid');
      return this.ledger.verified(id, task.report.sequence, verification, this.now());
    } catch {
      return this.ledger.verified(id, task.report.sequence, { ok: false, checks: ['verifier_unavailable'] }, this.now());
    }
  }
}
