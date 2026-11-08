import { z } from 'zod';
import { chiefConfigSchema, hash } from './contracts.js';

export const setupSchema = z.strictObject({
  requestId: z.string().min(1).max(200),
  config: chiefConfigSchema,
  /** Opaque placement label. Only infra maps it to a cloud location. */
  placement: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  sizeClass: z.enum(['small', 'medium', 'large']),
});
export type SetupRequest = z.infer<typeof setupSchema>;
/** Reviewable, cloud-neutral desired state. Infra owns the mapping to any provider; this has no side effects. */
export function provisionPlan(raw: unknown) {
  const setup = setupSchema.parse(raw);
  return {
    version: 1,
    requestDigest: hash(setup),
    idempotencyKey: `chief-setup-${hash([setup.config.organizationId, setup.requestId])}`,
    scope: { organizationId: setup.config.organizationId, workspaceId: setup.config.workspaceId,
      projectId: setup.config.projectId, chiefId: setup.config.chiefId },
    compute: { sizeClass: setup.sizeClass, placement: setup.placement, publicAccess: false, inboundRules: [],
      encryptedStorage: true, durableDataPath: '/var/lib/relay-chief',
      labels: { 'relay:service': 'relay-chief', 'relay:chief-id': setup.config.chiefId,
        'relay:organization-id': setup.config.organizationId, 'relay:workspace-id': setup.config.workspaceId,
        'relay:project-id': setup.config.projectId } },
    runtime: { user: 'relay-chief', configurationDigest: hash(setup.config),
      requiredCredentialBindings: ['RELAY_AGENT_TOKEN', 'TYPESAFE_API_KEY', 'CHIEF_CONTROL_PLANE_URL', 'CHIEF_CONTROL_PLANE_TOKEN'],
      writablePaths: ['/var/lib/relay-chief'], implementationCapability: false },
    accounting: { joinKey: setup.config.chiefId, providerCredentialIdentityMustBeDedicated: true,
      delegatedUsageMustBeAttributedSeparately: true },
    readinessChecks: ['configuration_valid', 'ledger_writable', 'relay_identity_matches',
      'evidence_source_authorized', 'execution_worker_available', 'verification_authority_available'],
    approvalRequired: ['deployment', 'iam', 'secret_bindings'],
  } as const;
}
