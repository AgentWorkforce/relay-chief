import { z } from 'zod';
import type { Assignment, RelayIdentity, RelayTransport } from './contracts.js';
import { canonical, hash, relayWorkspaceOf, reportSchema } from './contracts.js';
import type { Chief } from './chief.js';
import { origin, requestJson } from './http.js';

const identitySchema = z.object({ ok: z.literal(true), data: z.object({ id: z.string().min(1), workspace_id: z.string().min(1) }) });
const dmSchema = z.object({ ok: z.literal(true), data: z.object({
  message: z.object({ id: z.string().min(1), agent_id: z.string().min(1) }),
}) });
const conversationsSchema = z.object({ ok: z.literal(true), data: z.array(z.object({
  id: z.string().min(1), type: z.enum(['1:1', 'group']),
  participants: z.array(z.object({ agent_id: z.string().min(1) })),
})) });
const messagesSchema = z.object({ ok: z.literal(true), data: z.array(z.object({
  id: z.string().regex(/^\d{1,20}$/), agent_id: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
})) });

/** Relay message IDs are snowflakes of varying length, so they compare as numbers. */
function compareMessageIds(a: string, b: string): number {
  const [left, right] = [BigInt(a), BigInt(b)];
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Agent token only: no workspace admin credential, agent spawning or repository tools. */
export class RelayClient implements RelayTransport {
  private base: string;
  private token: string;
  private fetcher: typeof fetch;
  private caller?: RelayIdentity;
  private workspaceId?: string;
  /** `workspaceId` is the Relay workspace to require; without it, the assignment's workspace is used. */
  constructor(options: { baseUrl?: string; token: string; fetch?: typeof fetch; workspaceId?: string }) {
    this.base = origin(options.baseUrl ?? 'https://cast.agentrelay.com');
    if (!options.token.trim()) throw new Error('relay_credential_missing');
    this.token = options.token;
    this.fetcher = options.fetch ?? fetch;
    this.workspaceId = options.workspaceId;
  }
  private async request(path: string, body?: unknown, key?: string): Promise<unknown> {
    return requestJson(new URL(path, this.base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: canonical(body) }),
    }, this.fetcher);
  }
  async identity(): Promise<RelayIdentity> {
    const response = identitySchema.safeParse(await this.request('/v1/agent'));
    if (!response.success) throw new Error('relay_identity_invalid');
    this.caller = { origin: this.base, workspaceId: response.data.data.workspace_id, callerId: response.data.data.id };
    return this.caller;
  }
  async send(assignment: Assignment, digest: string): Promise<{ messageId: string }> {
    if (!this.caller || this.caller.workspaceId !== (this.workspaceId ?? assignment.workspaceId)) throw new Error('relay_identity_unresolved');
    const response = dmSchema.safeParse(await this.request('/v1/dm', {
      address: assignment.worker.address, mode: 'wait',
      text: `Relay Chief assignment ${assignment.taskId}: ${assignment.action} ${assignment.workKey} in ${assignment.repository}. Read the structured chief_assignment and acceptance criteria. Report using relay-chief.report.v1 over Relay.`,
      data: { chief_assignment: assignment, assignment_digest: digest },
    }, assignment.taskId));
    if (!response.success || response.data.data.message.agent_id !== this.caller.callerId) throw new Error('relay_receipt_invalid');
    return { messageId: response.data.data.message.id };
  }
  /** Pull reports from authorized 1:1 conversations, deriving sender identity from Relay. */
  async poll(chief: Chief): Promise<{ processed: number; rejected: number }> {
    const identity = await this.identity();
    if (identity.workspaceId !== relayWorkspaceOf(chief.config) || identity.callerId !== chief.config.relayCallerId) throw new Error('relay_scope_mismatch');
    chief.ledger.bindRelay(identity);
    const parsed = conversationsSchema.safeParse(await this.request('/v1/dm/conversations?limit=100'));
    if (!parsed.success) throw new Error('relay_conversations_invalid');
    // This route has no pagination contract. Fail explicitly rather than silently skip conversations.
    if (parsed.data.data.length >= 100) throw new Error('relay_conversation_limit');
    let processed = 0;
    let rejected = 0;
    // A removed worker may still own running work from the previous configuration.
    const workers = new Set([...chief.config.workers.map(worker => worker.agentId),
      ...chief.ledger.tasks().filter(task => !['canceled', 'completed'].includes(task.status)).map(task => task.assignment.worker.agentId)]);
    for (const conversation of parsed.data.data) {
      if (conversation.type !== '1:1' || !conversation.participants.some(p => workers.has(p.agent_id)) ||
          !conversation.participants.some(p => p.agent_id === identity.callerId)) continue;
      const cursorKey = `relay:${identity.origin}:${conversation.id}`;
      const cursor = chief.ledger.cursor(cursorKey);
      let before: string | undefined;
      const messages: z.infer<typeof messagesSchema>['data'] = [];
      for (;;) {
        const query = new URLSearchParams({ limit: '100', ...(cursor ? { after: cursor } : {}), ...(before ? { before } : {}) });
        const page = messagesSchema.safeParse(await this.request(`/v1/dm/${encodeURIComponent(conversation.id)}/messages?${query}`));
        if (!page.success) throw new Error('relay_messages_invalid');
        if (page.data.data.some(m => (cursor && compareMessageIds(m.id, cursor) <= 0) || (before && compareMessageIds(m.id, before) >= 0))) throw new Error('relay_page_invalid');
        messages.push(...page.data.data);
        if (messages.length > 1000) throw new Error('relay_report_backlog_limit');
        if (page.data.data.length < 100) break;
        const next = page.data.data.map(m => m.id).sort(compareMessageIds)[0];
        if (!next || next === before) throw new Error('relay_page_invalid');
        before = next;
      }
      messages.sort((a, b) => compareMessageIds(a.id, b.id));
      for (const message of messages) {
        if (!workers.has(message.agent_id) || !message.metadata?.chief_report) continue;
        const report = reportSchema.safeParse(message.metadata.chief_report);
        const reject = () => {
          chief.ledger.record({ evidenceDigest: hash(message.metadata!.chief_report), kind: 'uncertain',
            outcome: 'deferred', reason: 'relay_report_rejected' }, Date.now());
          rejected++;
        };
        if (!report.success) { reject(); continue; }
        try {
          await chief.receive({ workspaceId: chief.config.workspaceId, agentId: message.agent_id, report: report.data });
          processed++;
        } catch (error) {
          if (!(error instanceof Error) || !['task_not_found', 'report_identity_mismatch', 'report_before_dispatch',
            'report_sequence_conflict', 'report_after_terminal', 'report_state_regression'].includes(error.message)) throw error;
          // Quarantine invalid reports durably. Storage failures never advance the cursor.
          reject();
        }
      }
      const newest = messages.at(-1)?.id;
      if (newest) chief.ledger.checkpoint(cursorKey, cursor, newest);
    }
    return { processed, rejected };
  }
}
