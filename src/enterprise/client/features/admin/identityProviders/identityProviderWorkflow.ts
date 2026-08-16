import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

export const isIdentityProviderTestTerminal = (status: string): boolean =>
  status !== 'pending' && status !== 'processing';

export const isIdentityProviderDraftWorkflowReady = (
  provider: { status: string } | null | undefined,
): boolean => provider?.status === 'draft';

export type IdentityProviderWorkflowErrorKind =
  'corp-allowlist-required' | 'draft-required' | 'generic' | 'test-required';

export const classifyIdentityProviderWorkflowError = (
  error: unknown,
): IdentityProviderWorkflowErrorKind => {
  const mapped = mapEnterpriseError(error);
  const reason =
    mapped?.details && typeof mapped.details === 'object'
      ? (mapped.details as { reason?: unknown }).reason
      : undefined;
  if (reason === 'identity_provider_draft_required') return 'draft-required';
  if (reason === 'identity_provider_test_required') return 'test-required';
  if (reason === 'identity_provider_corp_allowlist_required') return 'corp-allowlist-required';
  return 'generic';
};

export const parseIdentityProviderJsonObject = (
  raw: string,
): { valid: false } | { valid: true; value: Record<string, unknown> } => {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false };
    return { valid: true, value: value as Record<string, unknown> };
  } catch {
    return { valid: false };
  }
};
