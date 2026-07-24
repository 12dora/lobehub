/**
 * Stable machine reason codes for user admin confirm-only actions.
 * Localized at audit-render time via `users.audit.autoReason.*` (see AuditTab).
 * Do not change codes once shipped — they are persisted in the audit trail.
 *
 * Kept in a lightweight module so AuditTab does not import modal UI trees.
 */

import { SHARED_OAUTH_AUTO_REASON } from '../managedResources/auditReasonCodes';

export const AUTO_REASON = {
  delete: 'admin.users.delete',
  revokeAll: 'admin.users.revoke_all_sessions',
  revokeOne: 'admin.users.revoke_session',
  roleRevoke: 'admin.users.revoke_role',
  roles: 'admin.users.replace_roles',
} as const;

export const CREATE_USER_AUTO_REASON = 'admin.users.create';

/** Legacy English prose reasons (pre-code) still present in historical audit rows. */
export const AUTO_REASON_LEGACY = {
  create: 'User created from admin console',
  delete: 'User hard-deleted from admin console',
  revokeAll: 'All sessions revoked from admin console',
  revokeOne: 'Session revoked from admin console',
  roleRevoke: 'Global role revoked from admin console',
  roles: 'Global roles updated from admin console',
  sharedOAuth: 'Set org shared OAuth authorization from managed resources',
} as const;

/**
 * Stable reason codes (+ legacy English prose from older clients) → i18n key under
 * `users.audit.autoReason.*`. User-entered free-form reasons stay verbatim.
 */
export const AUTO_REASON_I18N_KEY: Record<string, string> = {
  [AUTO_REASON.delete]: 'users.audit.autoReason.delete',
  [AUTO_REASON.revokeAll]: 'users.audit.autoReason.revokeAll',
  [AUTO_REASON.revokeOne]: 'users.audit.autoReason.revokeOne',
  [AUTO_REASON.roleRevoke]: 'users.audit.autoReason.roleRevoke',
  [AUTO_REASON.roles]: 'users.audit.autoReason.roles',
  [CREATE_USER_AUTO_REASON]: 'users.audit.autoReason.create',
  [SHARED_OAUTH_AUTO_REASON]: 'users.audit.autoReason.sharedOAuth',
  // Historical English machine strings (pre-code migration).
  [AUTO_REASON_LEGACY.create]: 'users.audit.autoReason.create',
  [AUTO_REASON_LEGACY.delete]: 'users.audit.autoReason.delete',
  [AUTO_REASON_LEGACY.revokeAll]: 'users.audit.autoReason.revokeAll',
  [AUTO_REASON_LEGACY.revokeOne]: 'users.audit.autoReason.revokeOne',
  [AUTO_REASON_LEGACY.roleRevoke]: 'users.audit.autoReason.roleRevoke',
  [AUTO_REASON_LEGACY.roles]: 'users.audit.autoReason.roles',
  [AUTO_REASON_LEGACY.sharedOAuth]: 'users.audit.autoReason.sharedOAuth',
};

/** Resolve a persisted audit reason for display. Free-form reasons pass through. */
export const formatAuditReason = (
  reason: string | null | undefined,
  t: (key: string, options?: { defaultValue?: string }) => string,
): string | null => {
  if (!reason) return null;
  const key = AUTO_REASON_I18N_KEY[reason];
  if (key) return t(key, { defaultValue: reason });
  return reason;
};
