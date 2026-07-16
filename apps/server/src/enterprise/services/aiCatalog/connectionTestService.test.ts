import { describe, expect, it } from 'vitest';

import type { PlatformAiProviderItem } from '@/database/schemas/platform';

import { AiCatalogConnectionTestService } from './connectionTestService';

const provider = {
  checkModel: 'test-model',
  config: {},
  displayName: 'Alpha',
  enabled: true,
  fetchOnClient: false,
  id: 'provider-1',
  providerKey: 'alpha',
  revision: 0,
  settings: {},
  sort: 0,
  source: 'custom',
  status: 'draft',
} as PlatformAiProviderItem;

describe('AiCatalogConnectionTestService', () => {
  it('returns only bounded status metadata on success', async () => {
    const service = new AiCatalogConnectionTestService(async () => {});
    const result = await service.test({ keyVaults: { apiKey: 'fake-key' }, provider });
    expect(result).toMatchObject({ errorCategory: null, status: 'success' });
    expect(result.testedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(result)).not.toContain('fake-key');
  });

  it('classifies and sanitizes failures without URL or credential leakage', async () => {
    const service = new AiCatalogConnectionTestService(async () => {
      const error = new Error('Unauthorized sk-fake-not-real-123456 at https://private.example/v1');
      Object.assign(error, { status: 401 });
      throw error;
    });
    const result = await service.test({ keyVaults: { apiKey: 'fake-key' }, provider });
    expect(result).toMatchObject({ errorCategory: 'auth', status: 'failure' });
    expect(result.sanitizedMessage).toContain('[REDACTED]');
    expect(result.sanitizedMessage).toContain('[endpoint]');
    expect(result.sanitizedMessage).not.toContain('private.example');
    expect(result.sanitizedMessage.length).toBeLessThanOrEqual(500);
  });
});
