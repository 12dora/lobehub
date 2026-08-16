import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { PlatformSecretService } from '@/server/enterprise/security/secret';

import { throwEnterpriseError } from '../../../guards/enterpriseErrors';
import {
  decryptModerationApiKey,
  encryptModerationApiKey,
  fingerprintModerationApiKey,
  maskModerationApiKey,
} from '../../../services/contentModeration/secrets';

export const MAX_MODERATION_API_KEYS = 20;

export interface MaskedModerationApiKey {
  fingerprint: string;
  masked: string;
}

export const requireSecretService = (
  secretService: PlatformSecretService | null,
): PlatformSecretService => {
  if (secretService) return secretService;
  return throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
    httpCode: 'PRECONDITION_FAILED',
  });
};

export const maskStoredApiKeys = async (params: {
  refs: readonly string[];
  secretService: PlatformSecretService | null;
}): Promise<MaskedModerationApiKey[]> => {
  if (params.refs.length === 0) return [];
  const secretService = requireSecretService(params.secretService);
  const keys: MaskedModerationApiKey[] = [];
  for (const ref of params.refs) {
    const plaintext = await decryptModerationApiKey(secretService, ref);
    keys.push({
      fingerprint: fingerprintModerationApiKey(plaintext),
      masked: maskModerationApiKey(plaintext),
    });
  }
  return keys;
};

/** Host case + trailing slash only — path remains case-sensitive. */
export const normalizeModerationBaseUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : '';
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${protocol}//${hostname}${port}${pathname}${parsed.search}`;
  } catch {
    return value.trim().replace(/\/+$/, '');
  }
};

export const assertRetainedKeysBoundToPersistedEndpoint = (params: {
  keep: readonly string[];
  persistedBaseUrl?: string;
  submittedBaseUrl?: string;
}): void => {
  if (params.keep.length === 0) return;
  const submitted = params.submittedBaseUrl;
  const persisted = params.persistedBaseUrl;
  if (!submitted) return;
  if (
    persisted &&
    normalizeModerationBaseUrl(persisted) === normalizeModerationBaseUrl(submitted)
  ) {
    return;
  }
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: {
      field: 'classifier.moderationsApi.baseUrl',
      reason: 'endpoint_changed_reenter_keys',
    },
    message: 'Moderations API keys must be re-entered when the endpoint changes.',
  });
};

export const assertCombinedApiKeyBound = (
  keep: readonly string[],
  add: readonly string[],
): void => {
  if (keep.length + add.length <= MAX_MODERATION_API_KEYS) return;
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: {
      field: 'classifier.moderationsApi.apiKeys',
      reason: 'too_many_api_keys',
    },
  });
};

export const resolveApiKeyRefs = async (params: {
  add: readonly string[];
  keep: readonly string[];
  secretService: PlatformSecretService | null;
  storedRefs: readonly string[];
}): Promise<string[]> => {
  if (params.keep.length === 0 && params.add.length === 0) return [];

  const secretService = requireSecretService(params.secretService);
  const keepSet = new Set(params.keep);
  const resolved: string[] = [];
  const found = new Set<string>();

  for (const ref of params.storedRefs) {
    const plaintext = await decryptModerationApiKey(secretService, ref);
    const fingerprint = fingerprintModerationApiKey(plaintext);
    if (!keepSet.has(fingerprint)) continue;
    resolved.push(ref);
    found.add(fingerprint);
  }

  for (const fingerprint of params.keep) {
    if (found.has(fingerprint)) continue;
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      details: {
        field: 'classifier.moderationsApi.apiKeys.keep',
        fingerprint,
        reason: 'api_key_fingerprint_not_found',
      },
    });
  }

  for (const plaintext of params.add) {
    resolved.push(await encryptModerationApiKey(secretService, plaintext));
  }

  return resolved;
};

export const resolvePlaintextApiKeys = async (params: {
  add: readonly string[];
  keep: readonly string[];
  secretService: PlatformSecretService | null;
  storedRefs: readonly string[];
}): Promise<string[]> => {
  const plaintext: string[] = [];
  if (params.keep.length > 0) {
    const secretService = requireSecretService(params.secretService);
    const keepSet = new Set(params.keep);
    const found = new Set<string>();
    for (const ref of params.storedRefs) {
      const value = await decryptModerationApiKey(secretService, ref);
      const fingerprint = fingerprintModerationApiKey(value);
      if (!keepSet.has(fingerprint)) continue;
      plaintext.push(value);
      found.add(fingerprint);
    }
    for (const fingerprint of params.keep) {
      if (found.has(fingerprint)) continue;
      throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        details: {
          field: 'classifier.moderationsApi.apiKeys.keep',
          fingerprint,
          reason: 'api_key_fingerprint_not_found',
        },
      });
    }
  }
  plaintext.push(...params.add);
  return plaintext;
};
