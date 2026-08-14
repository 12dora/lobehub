import {
  conditional,
  conditionalReauth,
  dangerousMutation,
  enforced,
  noReason,
  notApplicable,
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

export const ADMIN_MUTATION_ENTRIES_CATALOG = {
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
  'admin.agents.delete': dangerousMutation(
    'admin.agents.delete',
    'critical',
    'Hard delete a platform agent and all its versions, assignments, and materializations.',
    { reauth: recentReauth },
  ),
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
  'admin.aiModels.applyImmediate': dangerousMutation(
    'admin.aiModels.applyImmediate',
    'high',
    'Apply model draft mutation(s) and publish the parent provider immediately.',
    { outbound: safeOutbound, reauth: recentReauth },
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
  'admin.aiModels.update': regularMutation(
    'admin.aiModels.update',
    'medium',
    'Change a model in a provider draft.',
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
    'Apply provider draft changes and publish immediately (auto connection test at first publish).',
    { outbound: safeOutbound, reauth: recentReauth },
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
  'admin.aiProviders.delete': dangerousMutation(
    'admin.aiProviders.delete',
    'high',
    'Permanently delete an AI provider and all its models, secrets, and revisions.',
    { reauth: recentReauth },
  ),
  'admin.aiProviders.publish': dangerousMutation(
    'admin.aiProviders.publish',
    'high',
    'Publish AI provider configuration.',
    { reauth: recentReauth },
  ),
  'admin.aiProviders.publishNow': dangerousMutation(
    'admin.aiProviders.publishNow',
    'high',
    'Re-run first-publish connection test when required, then publish immediately.',
    { outbound: safeOutbound, reauth: recentReauth },
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
  'admin.skills.applyImmediate': dangerousMutation(
    'admin.skills.applyImmediate',
    'high',
    'Create or update a platform skill draft and publish immediately (no outbound).',
    { reauth: recentReauth },
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
    { reauth: recentReauth },
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
} as const satisfies Record<`admin.${string}`, AdminMutationDefinition>;
