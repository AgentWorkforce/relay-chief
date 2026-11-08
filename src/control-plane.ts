import { z } from 'zod';
import type { Assignment, AssignmentRegistry, ChiefConfig, CompletionVerifier, EvidencePage, EvidenceSource, Verification, WorkerReport } from './contracts.js';
import { evidenceSchema } from './contracts.js';
import { origin, requestJson } from './http.js';

/** Hosted integration contract. It does not assume these routes already exist in Cloud. */
export class ControlPlaneClient implements EvidenceSource, CompletionVerifier, AssignmentRegistry {
  readonly id = 'project-sessions-v1';
  private base: string;
  private token: string;
  private project: string;
  private fetcher: typeof fetch;
  constructor(options: { baseUrl: string; token: string; config: ChiefConfig; fetch?: typeof fetch }) {
    this.base = origin(options.baseUrl);
    if (!options.token.trim()) throw new Error('control_plane_credential_missing');
    this.token = options.token;
    this.project = `/chief/v1/projects/${encodeURIComponent(options.config.projectId)}`;
    this.fetcher = options.fetch ?? fetch;
  }
  private request(path: string): Promise<unknown> {
    return requestJson(new URL(path, this.base), { headers: { authorization: `Bearer ${this.token}` } }, this.fetcher);
  }
  async read(cursor: string | undefined): Promise<EvidencePage> {
    const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
    const page = z.strictObject({ cursor: z.string().min(1).max(2000), evidence: z.array(evidenceSchema).max(100) })
      .safeParse(await this.request(`${this.project}/evidence?${query}`));
    if (!page.success) throw new Error('evidence_page_invalid');
    return page.data;
  }
  async register(assignment: Assignment, digest: string): Promise<void> {
    await requestJson(new URL(`${this.project}/tasks/${encodeURIComponent(assignment.taskId)}/assignment`, this.base), {
      method: 'PUT', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ assignmentDigest: digest, assignment }),
    }, this.fetcher);
  }
  async verify(assignment: Assignment, report: WorkerReport): Promise<Verification> {
    // Fetch only the configured authority, never URLs supplied by a worker or session.
    const value = z.strictObject({ taskId: z.string(), assignmentDigest: z.string(),
      sequence: z.number().int(), ok: z.boolean(), checks: z.array(z.string().min(1).max(500)).max(100) })
      .safeParse(await this.request(`${this.project}/tasks/${encodeURIComponent(assignment.taskId)}/verification?sequence=${report.sequence}`));
    if (!value.success || value.data.taskId !== assignment.taskId || value.data.assignmentDigest !== report.assignmentDigest ||
        value.data.sequence !== report.sequence) throw new Error('verification_identity_mismatch');
    return { ok: value.data.ok, checks: value.data.checks };
  }
}
