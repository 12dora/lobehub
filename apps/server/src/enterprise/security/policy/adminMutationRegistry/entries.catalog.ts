import {
  conditional,
  conditionalReauth,
  dangerousMutation,
  enforced,
  noReason,
  notApplicable,
  optionalReasonInput,
  recentReauth,
  regularMutation,
  remoteProbeNoLkg,
  safeOutbound,
  validationAudit,
  validationMutation,
  validationNoLkg,
} from './helpers';
import type { AdminMutationDefinition } from './types';

/**
 * Device-flow endpoints come from the immutable builtin provider catalog, never from
 * admin input, so there is no address to validate — but they also do not travel
 * through the shared outbound policy client, which this states explicitly.
 */
const fixedProviderEndpointOutbound = conditional(
  'Remote endpoints are fixed constants of the builtin provider catalog and cannot be set by an operator.',
  'These fixed endpoints are not routed through the enterprise outbound policy client.',
);

/**
 * Task-template rows are ordinary authored content: the before/after state is fully captured by
 * the audit diff, so no separate operator justification is collected on every edit or toggle.
 */
const taskTemplateContentReason = notApplicable(
  'Task-template edits are recorded with their own before/after audit diff instead of an operator reason.',
);

const marketRecommendationOutbound = conditional(
  'The import calls only the fixed upstream marketplace recommendation endpoint, under a bounded abort deadline, outside the write transaction.',
  'The shared market client is not routed through the enterprise outbound policy boundary.',
);

/**
 * Content writes record a bounded sanitized diff of the row on both sides (before for
 * update/toggle/delete, after for create/update/toggle) inside the write transaction.
 */
const taskTemplateContentAudit = enforced(
  'Router persists a bounded sanitized before/after row summary in the same transaction as the write.',
);

/**
 * The import touches many rows at once, so its evidence is per-identifier: what each row became
 * and, for an overwrite, the content it replaced. Bounded by the import cap.
 */
const taskTemplateOrderAudit = enforced(
  'Router persists the resulting identifier order and slot assignment in the write transaction.',
);

const taskTemplateImportAudit = enforced(
  'Router persists per-identifier bounded sanitized before/after row summaries, plus batch counts, in the write transaction.',
);

/**
 * Agent-template rows are ordinary authored content: the before/after state is fully captured by
 * the audit diff, so no separate operator justification is collected on every edit or toggle.
 */
const agentTemplateContentReason = notApplicable(
  'Agent-template edits are recorded with their own before/after audit diff instead of an operator reason.',
);

const agentTemplateContentAudit = enforced(
  'Router persists a bounded sanitized before/after row summary in the same transaction as the write.',
);

const agentTemplateOrderAudit = enforced(
  'Router persists the resulting identifier order and slot assignment in the write transaction.',
);

const agentTemplateImportAudit = enforced(
  'Router persists per-identifier bounded sanitized before/after row summaries, plus batch counts, in the write transaction.',
);

export const ADMIN_MUTATION_ENTRIES_CATALOG = {
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
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.agents.assignments.upsert': dangerousMutation(
    'admin.agents.assignments.upsert',
    'high',
    'Create or change an agent assignment.',
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.agents.create': regularMutation(
    'admin.agents.create',
    'medium',
    'Create an agent and publish its first version live in one transaction.',
    { reason: optionalReasonInput },
  ),
  'admin.agents.delete': dangerousMutation(
    'admin.agents.delete',
    'critical',
    'Hard delete a platform agent and all its versions, assignments, and materializations.',
    { reauth: recentReauth },
  ),
  'admin.agents.rollback': dangerousMutation(
    'admin.agents.rollback',
    'high',
    'Move an agent publication pointer to an older version.',
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.agents.rollouts.cancel': dangerousMutation(
    'admin.agents.rollouts.cancel',
    'high',
    'Cancel an active agent rollout.',
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.agents.rollouts.retry': dangerousMutation(
    'admin.agents.rollouts.retry',
    'high',
    'Retry a failed agent rollout.',
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.agents.rollouts.rollback': dangerousMutation(
    'admin.agents.rollouts.rollback',
    'critical',
    'Roll back materialized agent state across users.',
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.agents.rollouts.start': dangerousMutation(
    'admin.agents.rollouts.start',
    'high',
    'Start materializing an agent assignment across users.',
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.agents.save': dangerousMutation(
    'admin.agents.save',
    'high',
    'Append an agent version and publish it to its consumers immediately (the only agent write).',
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.agents.setDefaultInbox': dangerousMutation(
    'admin.agents.setDefaultInbox',
    'critical',
    'Replace the global default inbox agent.',
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.agents.validateDependencies': validationMutation(
    'admin.agents.validateDependencies',
    'Validate agent references without persisting them.',
  ),
  'admin.aiModels.applyImmediate': dangerousMutation(
    'admin.aiModels.applyImmediate',
    'high',
    'Apply model mutation(s) and publish the parent provider immediately (the only model write).',
    { reauth: recentReauth },
  ),
  'admin.aiModels.syncUpstream': dangerousMutation(
    'admin.aiModels.syncUpstream',
    'high',
    'Discover models from the shared platform account and publish them into the catalog.',
    {
      outbound: safeOutbound,
      reason: conditional(
        'The procedure DTO has no operator reason; the service persists a server-authored audit reason on the sync action.',
        'The admin console does not prompt for a reason on this operation.',
      ),
      reauth: recentReauth,
    },
  ),
  // No outbound call at all: the provider-side grant is NOT revoked here, only the local
  // credential is withdrawn — so `outbound` stays at the default no-remote-request.
  'admin.aiProviderOAuth.disconnect': dangerousMutation(
    'admin.aiProviderOAuth.disconnect',
    'high',
    'Clear the stored shared platform provider authorization without disabling the provider.',
    { reauth: recentReauth },
  ),
  // Persists nothing itself, so it stays a regular mutation — but it opens the single-use
  // grant whose redemption stores a shared platform credential, so it carries the same
  // reauth gate and permission union as the store step (a stale session must fail here,
  // on the click-driven call, rather than after the grant is burned).
  'admin.aiProviderOAuth.initiateDeviceCode': regularMutation(
    'admin.aiProviderOAuth.initiateDeviceCode',
    'medium',
    'Request a device authorization code for a shared platform provider account.',
    {
      audit: validationAudit,
      lastKnownGood: remoteProbeNoLkg,
      outbound: fixedProviderEndpointOutbound,
      reason: noReason,
      reauth: recentReauth,
    },
  ),
  'admin.aiProviderOAuth.pollAuthStatus': dangerousMutation(
    'admin.aiProviderOAuth.pollAuthStatus',
    'high',
    'Store the authorized shared platform provider account and publish it immediately.',
    { outbound: fixedProviderEndpointOutbound, reauth: recentReauth },
  ),
  'admin.aiProviders.applyImmediate': dangerousMutation(
    'admin.aiProviders.applyImmediate',
    'high',
    'Apply provider changes and publish immediately (the only provider write; no remote probe).',
    { reauth: recentReauth },
  ),
  'admin.aiProviders.delete': dangerousMutation(
    'admin.aiProviders.delete',
    'critical',
    'Permanently delete an AI provider with all its models, secrets, and revision history.',
    { reauth: recentReauth },
  ),
  'admin.aiProviders.test': regularMutation(
    'admin.aiProviders.test',
    'medium',
    'Test an AI provider connection.',
    { lastKnownGood: remoteProbeNoLkg, outbound: safeOutbound },
  ),
  'admin.skills.applyImmediate': dangerousMutation(
    'admin.skills.applyImmediate',
    'high',
    'Create or update a platform skill draft and publish immediately (no outbound).',
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.skills.archive': dangerousMutation(
    'admin.skills.archive',
    'high',
    'Archive a published platform skill.',
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.skills.create': regularMutation(
    'admin.skills.create',
    'medium',
    'Create a platform skill draft.',
    { reason: optionalReasonInput, reauth: conditionalReauth },
  ),
  'admin.skills.createVersion': regularMutation(
    'admin.skills.createVersion',
    'medium',
    'Append an immutable platform skill version.',
    { reason: optionalReasonInput },
  ),
  'admin.skills.parseImportSource': regularMutation(
    'admin.skills.parseImportSource',
    'low',
    'Parse a skill package from a remote source or upload without persisting any state.',
    {
      audit: notApplicable(
        'The parse-only preview writes no platform state; the follow-up applyImmediate carries the audit.',
      ),
      lastKnownGood: validationNoLkg,
      outbound: enforced(
        'Remote fetches use the SSRF-safe fetch boundary with private-network blocking and a bounded timeout; repository downloads target the fixed GitHub archive host.',
      ),
      reason: notApplicable('The parse-only preview does not persist business configuration.'),
    },
  ),
  'admin.skills.publish': dangerousMutation(
    'admin.skills.publish',
    'high',
    'Publish a platform skill version.',
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.skills.publishNow': dangerousMutation(
    'admin.skills.publishNow',
    'high',
    'Retry publish for a platform skill draft (banner path, no outbound).',
    { reauth: recentReauth },
  ),
  'admin.skills.rollback': dangerousMutation(
    'admin.skills.rollback',
    'high',
    'Restore an earlier platform skill version.',
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.skills.updateDraft': regularMutation(
    'admin.skills.updateDraft',
    'medium',
    'Change a platform skill draft.',
    { reason: optionalReasonInput },
  ),
  'admin.skills.validate': regularMutation(
    'admin.skills.validate',
    'low',
    'Validate a stored platform skill version.',
    { reason: optionalReasonInput },
  ),
  'admin.agentTemplates.create': regularMutation(
    'admin.agentTemplates.create',
    'medium',
    'Create a platform agent template that users see as a create-agent example.',
    { audit: agentTemplateContentAudit, reason: agentTemplateContentReason },
  ),
  'admin.agentTemplates.delete': regularMutation(
    'admin.agentTemplates.delete',
    'medium',
    'Hard delete a platform agent template row; the example disappears for every user.',
    { audit: agentTemplateContentAudit, reason: agentTemplateContentReason },
  ),
  'admin.agentTemplates.importBuiltins': regularMutation(
    'admin.agentTemplates.importBuiltins',
    'medium',
    'Import the built-in create-agent examples and upsert them by identifier.',
    { audit: agentTemplateImportAudit, reason: agentTemplateContentReason },
  ),
  'admin.agentTemplates.reorder': regularMutation(
    'admin.agentTemplates.reorder',
    'low',
    'Change the display order of platform agent templates on the create-agent modal.',
    { audit: agentTemplateOrderAudit, reason: agentTemplateContentReason },
  ),
  'admin.agentTemplates.setEnabled': regularMutation(
    'admin.agentTemplates.setEnabled',
    'low',
    'Show or hide a single platform agent template without deleting its content.',
    { audit: agentTemplateContentAudit, reason: agentTemplateContentReason },
  ),
  'admin.agentTemplates.update': regularMutation(
    'admin.agentTemplates.update',
    'medium',
    'Change the content or visibility of a platform agent template.',
    { audit: agentTemplateContentAudit, reason: agentTemplateContentReason },
  ),
  'admin.taskTemplates.create': regularMutation(
    'admin.taskTemplates.create',
    'medium',
    'Create a platform task template that users see as a recommended scheduled task.',
    { audit: taskTemplateContentAudit, reason: taskTemplateContentReason },
  ),
  'admin.taskTemplates.delete': regularMutation(
    'admin.taskTemplates.delete',
    'medium',
    'Hard delete a platform task template row; the recommendation disappears for every user.',
    { audit: taskTemplateContentAudit, reason: taskTemplateContentReason },
  ),
  'admin.taskTemplates.importRecommendations': regularMutation(
    'admin.taskTemplates.importRecommendations',
    'medium',
    'Import the current upstream marketplace task-template recommendations and upsert them by identifier.',
    {
      audit: taskTemplateImportAudit,
      outbound: marketRecommendationOutbound,
      reason: taskTemplateContentReason,
    },
  ),
  'admin.taskTemplates.reorder': regularMutation(
    'admin.taskTemplates.reorder',
    'low',
    'Change the display order of platform task templates on the home and task-list surfaces.',
    { audit: taskTemplateOrderAudit, reason: taskTemplateContentReason },
  ),
  'admin.taskTemplates.setEnabled': regularMutation(
    'admin.taskTemplates.setEnabled',
    'low',
    'Show or hide a single platform task template without deleting its content.',
    { audit: taskTemplateContentAudit, reason: taskTemplateContentReason },
  ),
  'admin.taskTemplates.update': regularMutation(
    'admin.taskTemplates.update',
    'medium',
    'Change the content, schedule, or ordering of a platform task template.',
    { audit: taskTemplateContentAudit, reason: taskTemplateContentReason },
  ),
} as const satisfies Record<`admin.${string}`, AdminMutationDefinition>;
