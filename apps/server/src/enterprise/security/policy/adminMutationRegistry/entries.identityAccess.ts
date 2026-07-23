import {
  conditionalReauth,
  dangerousMutation,
  enforced,
  identityLkg,
  noReason,
  recentReauth,
  regularMutation,
  remoteProbeNoLkg,
  safeOutbound,
  validationMutation,
} from './helpers';
import type { AdminMutationDefinition } from './types';

export const ADMIN_MUTATION_ENTRIES_IDENTITY_ACCESS = {
  'admin.authSettings.update': regularMutation(
    'admin.authSettings.update',
    'medium',
    'Change platform registration settings: open-registration toggle and email-domain allowlist.',
    { reason: noReason },
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
  'admin.users.ban': dangerousMutation(
    'admin.users.ban',
    'critical',
    'Ban a user and revoke access.',
    { reauth: recentReauth },
  ),
  'admin.users.create': dangerousMutation(
    'admin.users.create',
    'critical',
    'Provision a new user account with sign-in access.',
    { reauth: recentReauth },
  ),
  'admin.users.delete': dangerousMutation(
    'admin.users.delete',
    'critical',
    'Irreversibly hard delete a user and all owned data.',
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
  'admin.roles.replaceUserGlobalRoles': dangerousMutation(
    'admin.roles.replaceUserGlobalRoles',
    'critical',
    'Replace the global roles assigned to a user.',
    { reauth: recentReauth },
  ),
  'admin.creds.createFile': dangerousMutation(
    'admin.creds.createFile',
    'high',
    'Create a platform global file entry from a staged upload.',
    {
      reason: enforced(
        'Router records a fixed audit reason for CredsApi-compatible mutations (no free-form reason field).',
      ),
      reauth: recentReauth,
    },
  ),
  'admin.creds.createKV': dangerousMutation(
    'admin.creds.createKV',
    'high',
    'Create a platform global KV entry with envelope-encrypted values.',
    {
      reason: enforced(
        'Router records a fixed audit reason for CredsApi-compatible mutations (no free-form reason field).',
      ),
      reauth: recentReauth,
    },
  ),
  'admin.creds.createOAuth': dangerousMutation(
    'admin.creds.createOAuth',
    'high',
    'Rejected OAuth create path for platform global entries (unsupported).',
    {
      reason: enforced(
        'Router records a fixed audit reason for CredsApi-compatible mutations (no free-form reason field).',
      ),
      reauth: recentReauth,
    },
  ),
  'admin.creds.delete': dangerousMutation(
    'admin.creds.delete',
    'high',
    'Delete a platform global entry by id.',
    {
      reason: enforced(
        'Router records a fixed audit reason for CredsApi-compatible mutations (no free-form reason field).',
      ),
      reauth: recentReauth,
    },
  ),
  'admin.creds.deleteByKey': dangerousMutation(
    'admin.creds.deleteByKey',
    'high',
    'Delete a platform global entry by stable key.',
    {
      reason: enforced(
        'Router records a fixed audit reason for CredsApi-compatible mutations (no free-form reason field).',
      ),
      reauth: recentReauth,
    },
  ),
  'admin.creds.update': dangerousMutation(
    'admin.creds.update',
    'high',
    'Update platform global entry metadata and/or rotate KV values.',
    {
      reason: enforced(
        'Router records a fixed audit reason for CredsApi-compatible mutations (no free-form reason field).',
      ),
      reauth: recentReauth,
    },
  ),
  'admin.creds.uploadFile': dangerousMutation(
    'admin.creds.uploadFile',
    'high',
    'Stage an envelope-encrypted file for a platform global entry.',
    {
      reason: enforced(
        'Router records a fixed audit reason for CredsApi-compatible mutations (no free-form reason field).',
      ),
      reauth: recentReauth,
    },
  ),
} as const satisfies Record<`admin.${string}`, AdminMutationDefinition>;
