/**
 * Reason (i18n key) the change-password button is disabled, or null when it is live.
 *
 * Order matters: the account-shape reason (SSO-only) outranks the actor-shape one
 * (self) so the admin is told the fact that will still be true tomorrow.
 */
export const resolveSetPasswordDisabledReason = (params: {
  hasPassword: boolean;
  /** False when the detail view is stale and high-risk actions are locked. */
  isLive: boolean;
  isSelf: boolean;
}): string | null => {
  if (!params.hasPassword) return 'users.security.password.ssoOnly';
  if (params.isSelf) return 'users.errors.selfAction';
  if (!params.isLive) return 'users.stale.refreshFailed';
  return null;
};
