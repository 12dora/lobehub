import {
  conditional,
  dangerousMutation,
  identityLkg,
  noReason,
  notApplicable,
  optionalReasonInput,
  prepareRestartAudit,
  recentReauth,
  regularMutation,
  remoteProbeNoLkg,
  safeOutbound,
  secretRotationAudit,
  secretRotationExternalGate,
  vaultKeyProviderBoundary,
} from './helpers';
import type { AdminMutationDefinition } from './types';

export const ADMIN_MUTATION_ENTRIES_PLATFORM = {
  'admin.contentModeration.clearDecisionCache': regularMutation(
    'admin.contentModeration.clearDecisionCache',
    'medium',
    'Delete every cached content-moderation decision so later prompts re-run the classifier.',
    { reason: noReason },
  ),
  'admin.contentModeration.deleteRecords': regularMutation(
    'admin.contentModeration.deleteRecords',
    'medium',
    'Permanently delete a bounded batch of content-moderation records.',
    { reason: noReason },
  ),
  'admin.contentModeration.revealRecordPrompt': regularMutation(
    'admin.contentModeration.revealRecordPrompt',
    'medium',
    'Reveal the stored full prompt of a content-moderation record and mark it as viewed.',
    { reason: noReason },
  ),
  'admin.contentModeration.testClassifier': regularMutation(
    'admin.contentModeration.testClassifier',
    'low',
    'Dry-run the keyword matcher and classifier against operator-supplied text without persisting.',
    {
      lastKnownGood: remoteProbeNoLkg,
      outbound: safeOutbound,
      reason: noReason,
    },
  ),
  'admin.contentModeration.updateSettings': regularMutation(
    'admin.contentModeration.updateSettings',
    'medium',
    'Replace the platform content-moderation configuration with CAS and a sanitized audit row.',
    { reason: noReason },
  ),
  'admin.managedResources.save': dangerousMutation(
    'admin.managedResources.save',
    'critical',
    'Apply the global managed-resource enforcement policy site-wide immediately.',
    { reauth: recentReauth },
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
  'admin.settings.save': dangerousMutation(
    'admin.settings.save',
    'critical',
    'Apply global platform settings policies site-wide immediately.',
    { reauth: recentReauth },
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
    { reason: optionalReasonInput, reauth: recentReauth },
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
    { reason: optionalReasonInput, reauth: recentReauth },
  ),
  'admin.system.testDependency': regularMutation(
    'admin.system.testDependency',
    'low',
    'Probe an environment-configured infrastructure dependency without persisting any change.',
    {
      audit: notApplicable(
        'The bounded live probe does not persist configuration or write an audit row.',
      ),
      lastKnownGood: remoteProbeNoLkg,
      outbound: conditional(
        'Resend probes use the enterprise outbound policy client with a bounded timeout. S3 and SMTP probes use native SDK clients.',
        'S3 and SMTP destinations come only from the process environment, not operator input, and are not routed through the outbound policy client.',
      ),
      reason: noReason,
    },
  ),
} as const satisfies Record<`admin.${string}`, AdminMutationDefinition>;
