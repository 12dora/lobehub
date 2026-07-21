export type AdminMutationRisk = 'critical' | 'high' | 'low' | 'medium';

export type ImplementedControl =
  | { evidence: string; status: 'enforced' }
  | { evidence: string; limitation: string; status: 'conditional' };

export type MissingControl = { gap: string; status: 'gap' } | { gap: string; status: 'planned' };

export interface NotApplicableControl {
  rationale: string;
  status: 'not-applicable';
}

export type AdminMutationControl = ImplementedControl | MissingControl | NotApplicableControl;
export type RequiredAdminMutationControl = ImplementedControl | MissingControl;

export interface AdminMutationControls {
  audit: AdminMutationControl;
  lastKnownGood: AdminMutationControl;
  outbound: AdminMutationControl;
  rateLimit: AdminMutationControl;
  reason: AdminMutationControl;
  reauth: AdminMutationControl;
}

interface AdminMutationDefinitionBase {
  controls: AdminMutationControls;
  procedure: `admin.${string}`;
  summary: string;
}

export interface DangerousAdminMutationDefinition extends AdminMutationDefinitionBase {
  controls: AdminMutationControls & {
    audit: RequiredAdminMutationControl;
    rateLimit: RequiredAdminMutationControl;
    reason: RequiredAdminMutationControl;
    reauth: RequiredAdminMutationControl;
  };
  dangerous: true;
  risk: 'critical' | 'high';
}

export interface RegularAdminMutationDefinition extends AdminMutationDefinitionBase {
  dangerous: false;
  risk: 'low' | 'medium';
}

export type AdminMutationDefinition =
  DangerousAdminMutationDefinition | RegularAdminMutationDefinition;

const enforced = (evidence: string): ImplementedControl => ({ evidence, status: 'enforced' });
const conditional = (evidence: string, limitation: string): ImplementedControl => ({
  evidence,
  limitation,
  status: 'conditional',
});
const notApplicable = (rationale: string): NotApplicableControl => ({
  rationale,
  status: 'not-applicable',
});

const reasonInput = enforced('Bounded non-empty reason in the procedure input contract.');
const serviceAudit = enforced('Service persists a sanitized platform audit outcome.');
const sensitiveSafeReason = enforced(
  'The router bounds the reason and the service rejects centralized sensitive-material matches.',
);
const atomicOutcomeAudit = enforced(
  'Snapshot, role, and outcome audit writes share one database transaction.',
);
const recentReauth = enforced('Router checks the server-authenticated recent-session timestamp.');
const conditionalReauth = conditional(
  'Router checks recent authentication for sensitive input variants.',
  'Ordinary draft variants do not require the check.',
);
const sharedAdminRateLimit = enforced(
  'Shared multi-instance admin mutation rate limiter is attached to the final tRPC mutation chain.',
);
const noRemoteRequest = notApplicable('The operation does not make a server-side remote request.');
const databaseStateNoLkg = notApplicable(
  'The procedure reads or changes authoritative database state and has no derived LKG path.',
);
const validationNoLkg = notApplicable(
  'Validation creates no runtime state that requires recovery.',
);
const remoteProbeNoLkg = notApplicable(
  'The bounded remote probe creates no published runtime state that requires recovery.',
);
const assetNoLkg = notApplicable(
  'Asset recovery uses object-storage operation records rather than an LKG file.',
);
const noReason = notApplicable('The validation operation does not persist business configuration.');
const validationAudit = enforced(
  'Service or router persists a sanitized success or failure platform audit outcome.',
);
const prepareRestartAudit = enforced(
  'Prepared restart intent and sanitized success audit share one transaction; failure and reauth denial audits are best effort after rollback.',
);
const safeOutbound = enforced('Remote requests use the enterprise outbound policy boundary.');
const identityLkg = conditional(
  'Startup verifies signature, age, ownership, and permissions before reading a local LKG.',
  'A valid database candidate remains active when the local LKG write fails; startup reports degraded.',
);
const secretRotationExternalGate = conditional(
  'API and worker results always report historicalKeyRemovalReady=false and require identity LKG instance convergence.',
  'OIDC LKG convergence and historical KEK removal approval remain external operational gates.',
);
const secretRotationAudit = enforced(
  'Coordinator mutation and sanitized success audit share one transaction; failure and reauth denial audits are best effort after rollback.',
);
const vaultKeyProviderBoundary = enforced(
  'Start verifies the selected Vault provider and exact active key through its bounded fail-closed client.',
);

const regularMutation = (
  procedure: `admin.${string}`,
  risk: RegularAdminMutationDefinition['risk'],
  summary: string,
  overrides: Partial<AdminMutationControls> = {},
): RegularAdminMutationDefinition => ({
  controls: {
    audit: serviceAudit,
    lastKnownGood: databaseStateNoLkg,
    outbound: noRemoteRequest,
    rateLimit: sharedAdminRateLimit,
    reason: reasonInput,
    reauth: notApplicable('The current policy does not classify this operation as dangerous.'),
    ...overrides,
  },
  dangerous: false,
  procedure,
  risk,
  summary,
});

const dangerousMutation = (
  procedure: `admin.${string}`,
  risk: DangerousAdminMutationDefinition['risk'],
  summary: string,
  options: {
    audit?: RequiredAdminMutationControl;
    lastKnownGood?: AdminMutationControl;
    outbound?: AdminMutationControl;
    reason?: RequiredAdminMutationControl;
    reauth: RequiredAdminMutationControl;
  },
): DangerousAdminMutationDefinition => ({
  controls: {
    audit: options.audit ?? serviceAudit,
    lastKnownGood: options.lastKnownGood ?? databaseStateNoLkg,
    outbound: options.outbound ?? noRemoteRequest,
    rateLimit: sharedAdminRateLimit,
    reason: options.reason ?? reasonInput,
    reauth: options.reauth,
  },
  dangerous: true,
  procedure,
  risk,
  summary,
});

const validationMutation = (
  procedure: `admin.${string}`,
  summary: string,
  overrides: Partial<AdminMutationControls> = {},
) =>
  regularMutation(procedure, 'low', summary, {
    audit: validationAudit,
    lastKnownGood: validationNoLkg,
    reason: noReason,
    ...overrides,
  });

export const ADMIN_MUTATION_REGISTRY = {
  'admin.agents.appendVersion': regularMutation(
    'admin.agents.appendVersion',
    'medium',
    'Append an immutable agent version.',
  ),
  'admin.agents.archive': dangerousMutation(
    'admin.agents.archive',
    'high',
    'Archive an agent and change its availability.',
    { reauth: recentReauth },
  ),
  'admin.agents.assignments.remove': dangerousMutation(
    'admin.agents.assignments.remove',
    'high',
    'Remove an agent assignment from a target scope.',
    { reauth: recentReauth },
  ),
  'admin.agents.assignments.upsert': dangerousMutation(
    'admin.agents.assignments.upsert',
    'high',
    'Create or change an agent assignment.',
    { reauth: recentReauth },
  ),
  'admin.agents.create': regularMutation('admin.agents.create', 'medium', 'Create an agent draft.'),
  'admin.agents.publish': dangerousMutation(
    'admin.agents.publish',
    'high',
    'Publish an agent version to its consumers.',
    { reauth: recentReauth },
  ),
  'admin.agents.rollback': dangerousMutation(
    'admin.agents.rollback',
    'high',
    'Move an agent publication pointer to an older version.',
    { reauth: recentReauth },
  ),
  'admin.agents.rollouts.cancel': dangerousMutation(
    'admin.agents.rollouts.cancel',
    'high',
    'Cancel an active agent rollout.',
    { reauth: recentReauth },
  ),
  'admin.agents.rollouts.retry': dangerousMutation(
    'admin.agents.rollouts.retry',
    'high',
    'Retry a failed agent rollout.',
    { reauth: recentReauth },
  ),
  'admin.agents.rollouts.rollback': dangerousMutation(
    'admin.agents.rollouts.rollback',
    'critical',
    'Roll back materialized agent state across users.',
    { reauth: recentReauth },
  ),
  'admin.agents.rollouts.start': dangerousMutation(
    'admin.agents.rollouts.start',
    'high',
    'Start materializing an agent assignment across users.',
    { reauth: recentReauth },
  ),
  'admin.agents.setDefaultInbox': dangerousMutation(
    'admin.agents.setDefaultInbox',
    'critical',
    'Replace the global default inbox agent.',
    { reauth: recentReauth },
  ),
  'admin.agents.updateDraft': regularMutation(
    'admin.agents.updateDraft',
    'medium',
    'Change an agent draft.',
  ),
  'admin.agents.validateDependencies': validationMutation(
    'admin.agents.validateDependencies',
    'Validate agent references without persisting them.',
  ),
  'admin.aiModels.create': regularMutation(
    'admin.aiModels.create',
    'medium',
    'Add a model to a provider draft.',
  ),
  'admin.aiModels.deleteFromDraft': regularMutation(
    'admin.aiModels.deleteFromDraft',
    'medium',
    'Remove a model from a provider draft.',
  ),
  'admin.aiModels.reorder': regularMutation(
    'admin.aiModels.reorder',
    'medium',
    'Reorder models in a provider draft.',
  ),
  'admin.aiModels.applyImmediate': dangerousMutation(
    'admin.aiModels.applyImmediate',
    'critical',
    'Create or update a platform AI model draft and publish immediately.',
    { reauth: recentReauth },
  ),
  'admin.aiModels.update': regularMutation(
    'admin.aiModels.update',
    'medium',
    'Change a model in a provider draft.',
  ),
  'admin.aiProviders.applyImmediate': dangerousMutation(
    'admin.aiProviders.applyImmediate',
    'critical',
    'Create or update a platform AI provider draft and publish immediately.',
    { reauth: recentReauth },
  ),
  'admin.aiProviders.archive': dangerousMutation(
    'admin.aiProviders.archive',
    'high',
    'Archive a published AI provider.',
    { reauth: recentReauth },
  ),
  'admin.aiProviders.createDraft': regularMutation(
    'admin.aiProviders.createDraft',
    'medium',
    'Create an AI provider draft.',
    { reauth: conditionalReauth },
  ),
  'admin.aiProviders.publish': dangerousMutation(
    'admin.aiProviders.publish',
    'high',
    'Publish AI provider configuration.',
    { reauth: recentReauth },
  ),
  'admin.aiProviders.publishNow': dangerousMutation(
    'admin.aiProviders.publishNow',
    'critical',
    'Retry publish for a platform AI provider draft after validation.',
    { reauth: recentReauth },
  ),
  'admin.aiProviders.rollback': dangerousMutation(
    'admin.aiProviders.rollback',
    'high',
    'Roll back published AI provider configuration.',
    { reauth: recentReauth },
  ),
  'admin.aiProviders.test': regularMutation(
    'admin.aiProviders.test',
    'medium',
    'Test an AI provider connection.',
    { lastKnownGood: remoteProbeNoLkg, outbound: safeOutbound },
  ),
  'admin.aiProviders.updateDraft': regularMutation(
    'admin.aiProviders.updateDraft',
    'medium',
    'Change an AI provider draft.',
    { reauth: conditionalReauth },
  ),
  'admin.branding.publish': dangerousMutation(
    'admin.branding.publish',
    'high',
    'Publish global product branding.',
    { reauth: recentReauth },
  ),
  'admin.branding.rollback': dangerousMutation(
    'admin.branding.rollback',
    'high',
    'Restore an earlier branding revision.',
    { reauth: recentReauth },
  ),
  'admin.branding.saveDraft': regularMutation(
    'admin.branding.saveDraft',
    'medium',
    'Change the global branding draft.',
  ),
  'admin.branding.uploadAsset': regularMutation(
    'admin.branding.uploadAsset',
    'medium',
    'Upload and validate a branding asset.',
    { lastKnownGood: assetNoLkg },
  ),
  'admin.connectors.archive': dangerousMutation(
    'admin.connectors.archive',
    'high',
    'Archive a published connector.',
    { reauth: recentReauth },
  ),
  'admin.connectors.createDraft': regularMutation(
    'admin.connectors.createDraft',
    'medium',
    'Create a connector draft.',
    { reauth: conditionalReauth },
  ),
  'admin.connectors.deleteDraft': regularMutation(
    'admin.connectors.deleteDraft',
    'medium',
    'Delete an unpublished connector draft.',
  ),
  'admin.connectors.discover': regularMutation(
    'admin.connectors.discover',
    'medium',
    'Discover connector tools through the guarded remote boundary.',
    { lastKnownGood: remoteProbeNoLkg, outbound: safeOutbound },
  ),
  'admin.connectors.publish': dangerousMutation(
    'admin.connectors.publish',
    'high',
    'Publish connector configuration for runtime use.',
    { outbound: safeOutbound, reauth: recentReauth },
  ),
  'admin.connectors.revokeAllBindings': dangerousMutation(
    'admin.connectors.revokeAllBindings',
    'critical',
    'Revoke every user binding for a connector.',
    { reauth: recentReauth },
  ),
  'admin.connectors.rollback': dangerousMutation(
    'admin.connectors.rollback',
    'high',
    'Roll back published connector configuration.',
    { outbound: safeOutbound, reauth: recentReauth },
  ),
  'admin.connectors.test': regularMutation(
    'admin.connectors.test',
    'medium',
    'Test a connector through the guarded remote boundary.',
    { lastKnownGood: remoteProbeNoLkg, outbound: safeOutbound },
  ),
  'admin.connectors.updateDraft': regularMutation(
    'admin.connectors.updateDraft',
    'medium',
    'Change a connector draft.',
    { reauth: conditionalReauth },
  ),
  'admin.easyauth.triggerSync': dangerousMutation(
    'admin.easyauth.triggerSync',
    'high',
    'Synchronize externally managed global role grants for a user.',
    {
      audit: atomicOutcomeAudit,
      outbound: safeOutbound,
      reason: sensitiveSafeReason,
      reauth: recentReauth,
    },
  ),
  'admin.identityProviders.create': regularMutation(
    'admin.identityProviders.create',
    'medium',
    'Create an identity provider draft.',
    { reauth: conditionalReauth },
  ),
  'admin.identityProviders.delete': dangerousMutation(
    'admin.identityProviders.delete',
    'high',
    'Delete an identity provider draft.',
    { reauth: recentReauth },
  ),
  'admin.identityProviders.discover': validationMutation(
    'admin.identityProviders.discover',
    'Discover identity metadata through the guarded remote boundary.',
    { lastKnownGood: remoteProbeNoLkg, outbound: safeOutbound },
  ),
  'admin.identityProviders.publish': dangerousMutation(
    'admin.identityProviders.publish',
    'critical',
    'Publish login configuration used on the next restart.',
    { lastKnownGood: identityLkg, outbound: safeOutbound, reauth: recentReauth },
  ),
  'admin.identityProviders.rollback': dangerousMutation(
    'admin.identityProviders.rollback',
    'critical',
    'Restore an earlier login configuration revision.',
    { lastKnownGood: identityLkg, outbound: safeOutbound, reauth: recentReauth },
  ),
  'admin.identityProviders.testStart': regularMutation(
    'admin.identityProviders.testStart',
    'medium',
    'Start an isolated identity provider login test.',
    { lastKnownGood: remoteProbeNoLkg, outbound: safeOutbound },
  ),
  'admin.identityProviders.update': regularMutation(
    'admin.identityProviders.update',
    'medium',
    'Change an identity provider draft.',
    { reauth: conditionalReauth },
  ),
  'admin.identityProviders.validateNetwork': validationMutation(
    'admin.identityProviders.validateNetwork',
    'Validate identity endpoints through the guarded remote boundary.',
    { lastKnownGood: remoteProbeNoLkg, outbound: safeOutbound },
  ),
  'admin.managedResources.publish': dangerousMutation(
    'admin.managedResources.publish',
    'critical',
    'Publish global managed-resource enforcement policy.',
    { reauth: recentReauth },
  ),
  'admin.managedResources.saveDraft': regularMutation(
    'admin.managedResources.saveDraft',
    'medium',
    'Change the managed-resource policy draft.',
  ),
  'admin.roles.replaceUserGlobalRoles': dangerousMutation(
    'admin.roles.replaceUserGlobalRoles',
    'critical',
    'Replace the global roles assigned to a user.',
    { reauth: recentReauth },
  ),
  'admin.security.secretRotation.cancel': dangerousMutation(
    'admin.security.secretRotation.cancel',
    'critical',
    'Stop future batches of an active secret re-wrap job without reverting committed envelopes.',
    { audit: secretRotationAudit, reauth: recentReauth },
  ),
  'admin.security.secretRotation.retry': dangerousMutation(
    'admin.security.secretRotation.retry',
    'critical',
    'Retry the exact failed ledger of a secret re-wrap job.',
    {
      audit: secretRotationAudit,
      lastKnownGood: secretRotationExternalGate,
      reauth: recentReauth,
    },
  ),
  'admin.security.secretRotation.start': dangerousMutation(
    'admin.security.secretRotation.start',
    'critical',
    'Start a Vault-backed full-domain secret re-wrap job.',
    {
      audit: secretRotationAudit,
      lastKnownGood: secretRotationExternalGate,
      outbound: vaultKeyProviderBoundary,
      reauth: recentReauth,
    },
  ),
  'admin.settings.applyImmediate': dangerousMutation(
    'admin.settings.applyImmediate',
    'critical',
    'Merge path values into global settings and publish immediately.',
    { reauth: recentReauth },
  ),
  'admin.settings.publish': dangerousMutation(
    'admin.settings.publish',
    'critical',
    'Publish global platform settings.',
    { reauth: recentReauth },
  ),
  'admin.settings.rollback': dangerousMutation(
    'admin.settings.rollback',
    'critical',
    'Restore an earlier global settings revision.',
    { reauth: recentReauth },
  ),
  'admin.settings.saveDraft': regularMutation(
    'admin.settings.saveDraft',
    'medium',
    'Change the global settings draft.',
  ),
  'admin.settings.validateDraft': validationMutation(
    'admin.settings.validateDraft',
    'Validate settings without publishing them.',
  ),
  'admin.skills.archive': dangerousMutation(
    'admin.skills.archive',
    'high',
    'Archive a published platform skill.',
    { reauth: recentReauth },
  ),
  'admin.skills.create': regularMutation(
    'admin.skills.create',
    'medium',
    'Create a platform skill draft.',
    { reauth: conditionalReauth },
  ),
  'admin.skills.createVersion': regularMutation(
    'admin.skills.createVersion',
    'medium',
    'Append an immutable platform skill version.',
  ),
  'admin.skills.publish': dangerousMutation(
    'admin.skills.publish',
    'high',
    'Publish a platform skill version.',
    { reauth: recentReauth },
  ),
  'admin.skills.rollback': dangerousMutation(
    'admin.skills.rollback',
    'high',
    'Restore an earlier platform skill version.',
    { reauth: recentReauth },
  ),
  'admin.skills.updateDraft': regularMutation(
    'admin.skills.updateDraft',
    'medium',
    'Change a platform skill draft.',
  ),
  'admin.skills.validate': regularMutation(
    'admin.skills.validate',
    'low',
    'Validate a stored platform skill version.',
  ),
  'admin.system.cancelJob': dangerousMutation(
    'admin.system.cancelJob',
    'high',
    'Cancel an eligible active platform job with atomic compare-and-set.',
    { reauth: recentReauth },
  ),
  'admin.system.prepareRestart': dangerousMutation(
    'admin.system.prepareRestart',
    'critical',
    'Create a bounded restart intent for identity configuration.',
    { audit: prepareRestartAudit, lastKnownGood: identityLkg, reauth: recentReauth },
  ),
  'admin.system.requestRestart': dangerousMutation(
    'admin.system.requestRestart',
    'critical',
    'Request process restart to activate identity configuration.',
    { lastKnownGood: identityLkg, reauth: recentReauth },
  ),
  'admin.system.retryJob': dangerousMutation(
    'admin.system.retryJob',
    'high',
    'Retry an eligible terminal platform job with atomic compare-and-set.',
    { reauth: recentReauth },
  ),
  'admin.users.ban': dangerousMutation(
    'admin.users.ban',
    'critical',
    'Ban a user and revoke access.',
    { reauth: recentReauth },
  ),
  'admin.users.replaceGlobalRoles': dangerousMutation(
    'admin.users.replaceGlobalRoles',
    'critical',
    'Replace the global roles assigned to a user.',
    { reauth: recentReauth },
  ),
  'admin.users.revokeSessions': dangerousMutation(
    'admin.users.revokeSessions',
    'critical',
    'Revoke active sessions for a user.',
    { reauth: recentReauth },
  ),
  'admin.users.unban': dangerousMutation(
    'admin.users.unban',
    'high',
    'Restore login access for a banned user.',
    { reauth: recentReauth },
  ),
} as const satisfies Record<`admin.${string}`, AdminMutationDefinition>;

export type AdminMutationProcedure = keyof typeof ADMIN_MUTATION_REGISTRY;
