/**
 * Merge admin reauth flags into OAuth authorization URL params.
 * Used by generic OAuth providers (Authentik, etc.) when sign-in passes
 * additionalData.reauth / prompt=login. Normal sign-in is unchanged.
 */
export const mergeReauthAuthorizationParams = (
  base: Record<string, string>,
  additionalData?: Record<string, unknown> | null,
): Record<string, string> => {
  if (additionalData?.reauth === true || additionalData?.prompt === 'login') {
    return {
      ...base,
      max_age: '0',
      prompt: 'login',
    };
  }
  return { ...base };
};
