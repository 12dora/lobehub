import type { TFunction } from 'i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

import {
  classifyIdentityProviderWorkflowError,
  extractIdentityProviderTestErrorCode,
  identityProviderTestErrorKey,
  IdentityProviderTestPopupBlockedError,
} from './controller';

export const resolveIdentityProviderWizardErrorMessage = (
  cause: unknown,
  t: TFunction<'admin'>,
): string => {
  if (cause instanceof IdentityProviderTestPopupBlockedError) {
    return t('identityProviders.test.popupBlocked');
  }
  const mapped = mapEnterpriseError(cause);
  if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
    return t('identityProviders.conflict.description');
  }
  if (mapped?.code === 'PLATFORM_SSRF_BLOCKED') {
    return t('identityProviders.errors.networkBlocked');
  }
  if (mapped?.code === 'PLATFORM_OIDC_DISCOVERY_FAILED') {
    return t('identityProviders.errors.discoveryFailed');
  }
  const workflowError = classifyIdentityProviderWorkflowError(cause);
  if (workflowError === 'draft-required') {
    return t('identityProviders.workflow.draftRequired');
  }
  if (workflowError === 'test-required') {
    return t('identityProviders.workflow.testRequired');
  }
  if (workflowError === 'corp-allowlist-required') {
    return t('identityProviders.dingtalk.allowedCorps.publishBlocked');
  }
  // Safe-login / capture failures carry a stable OIDC_TEST_* code. Surfacing the mapped
  // instruction (wrong AppSecret, redirect URL not registered, `corpid` scope missing …)
  // is the difference between an actionable message and "something went wrong".
  const testErrorCode = extractIdentityProviderTestErrorCode(cause);
  if (testErrorCode) return t(identityProviderTestErrorKey(testErrorCode) as never);
  return t('identityProviders.errors.generic');
};
