import {
  dangerousMutation,
  identityLkg,
  noReason,
  prepareRestartAudit,
  recentReauth,
  regularMutation,
  secretRotationAudit,
  secretRotationExternalGate,
  validationMutation,
  vaultKeyProviderBoundary,
} from './helpers';
import type { AdminMutationDefinition } from './types';

export const ADMIN_MUTATION_ENTRIES_PLATFORM = {
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
  'admin.security.secretRotation.cancel': dangerousMutation(
    'admin.security.secretRotation.cancel',
    'critical',
    'Stop future batches of an active secret re-wrap job without reverting committed envelopes.',
    { audit: secretRotationAudit, reauth: recentReauth },
  ),
  'admin.security.secretRotation.restart': dangerousMutation(
    'admin.security.secretRotation.restart',
    'critical',
    'Restart a cancelled or dead secret re-wrap job as a new generation.',
    {
      audit: secretRotationAudit,
      lastKnownGood: secretRotationExternalGate,
      reauth: recentReauth,
    },
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
  'admin.sidebarLayout.update': regularMutation(
    'admin.sidebarLayout.update',
    'medium',
    'Change the platform home-sidebar layout policy (user vs platform-managed).',
    { reason: noReason },
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
} as const satisfies Record<`admin.${string}`, AdminMutationDefinition>;
