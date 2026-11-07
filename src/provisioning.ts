import { z } from 'zod';
import { chiefConfigSchema, hash } from './contracts.js';

export const setupSchema = z.strictObject({
  requestId: z.string().min(1).max(200),
  config: chiefConfigSchema,
  region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  instanceType: z.enum(['t4g.small', 't4g.medium', 't4g.large']),
});
export type SetupRequest = z.infer<typeof setupSchema>;
/** Reviewable desired state only. This module has no AWS SDK or side effects. */
export function provisionPlan(raw: unknown) {
  const setup = setupSchema.parse(raw);
  return {
    version: 1,
    requestDigest: hash(setup),
    idempotencyKey: `chief-setup-${hash([setup.config.organizationId, setup.requestId])}`,
    scope: { organizationId: setup.config.organizationId, workspaceId: setup.config.workspaceId,
      projectId: setup.config.projectId, chiefId: setup.config.chiefId },
    compute: { provider: 'ec2', region: setup.region, instanceType: setup.instanceType,
      architecture: 'arm64', publicIp: false, inboundRules: [], encryptedRootVolume: true,
      metadataTokens: 'required', durableDataPath: '/var/lib/relay-chief',
      tags: { 'relay:service': 'relay-chief', 'relay:chief-id': setup.config.chiefId,
        'relay:organization-id': setup.config.organizationId, 'relay:workspace-id': setup.config.workspaceId,
        'relay:project-id': setup.config.projectId } },
    runtime: { user: 'relay-chief', configurationDigest: hash(setup.config),
      requiredCredentialBindings: ['RELAY_AGENT_TOKEN', 'TYPESAFE_API_KEY', 'CHIEF_CONTROL_PLANE_TOKEN'],
      writablePaths: ['/var/lib/relay-chief'], implementationCapability: false },
    accounting: { joinKey: setup.config.chiefId, providerCredentialIdentityMustBeDedicated: true,
      delegatedUsageMustBeAttributedSeparately: true },
    readinessChecks: ['configuration_valid', 'ledger_writable', 'relay_identity_matches',
      'evidence_source_authorized', 'execution_worker_available', 'verification_authority_available'],
    approvalRequired: ['deployment', 'iam', 'secret_bindings'],
  } as const;
}
