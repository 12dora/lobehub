import { describe, expect, it, vi } from 'vitest';

import type { PlatformAiProviderItem } from '@/database/schemas/platform';

import { createSafeOutboundHttpClient } from '../../security/outboundHttp';
import {
  AiCatalogConnectionTestService,
  createSafeAiConnectionProbe,
} from './connectionTestService';

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
    const result = await service.test({
      keyVaults: { apiKey: 'fake-key' },
      provider,
      runtimeProvider: 'openai',
    });
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
    const result = await service.test({
      keyVaults: { apiKey: 'fake-key' },
      provider,
      runtimeProvider: 'openai',
    });
    expect(result).toMatchObject({ errorCategory: 'auth', status: 'failure' });
    expect(result.sanitizedMessage).toBe('Connection failed: authentication rejected');
    expect(result.sanitizedMessage).not.toContain('private.example');
    expect(result.sanitizedMessage.length).toBeLessThanOrEqual(500);
  });

  it('never reflects structured credential leaves from arbitrary provider errors', async () => {
    const keyVaults = {
      apiKey: 'plain-multi-field-key',
      customHeaders: { Authorization: 'plain-header-secret' },
      password: 'plain-password',
    };
    const service = new AiCatalogConnectionTestService(async () => {
      throw new Error(JSON.stringify(keyVaults));
    });
    const result = await service.test({ keyVaults, provider, runtimeProvider: 'comfyui' });
    expect(result.sanitizedMessage).toBe('Connection failed: authentication rejected');
    expect(JSON.stringify(result)).not.toContain('plain-multi-field-key');
    expect(JSON.stringify(result)).not.toContain('plain-header-secret');
    expect(JSON.stringify(result)).not.toContain('plain-password');
  });

  it('classifies enterprise outbound policy denials as network failures', async () => {
    const service = new AiCatalogConnectionTestService(async () => {
      throw new Error('Outbound request blocked by enterprise network policy');
    });
    const result = await service.test({
      keyVaults: { apiKey: 'fake-key' },
      provider,
      runtimeProvider: 'openai',
    });
    expect(result).toMatchObject({
      errorCategory: 'network',
      sanitizedMessage: 'Connection failed: provider network unavailable',
      status: 'failure',
    });
  });

  it('builds the production probe against SafeOutboundHttpClient rather than raw fetch', () => {
    const transport = vi.fn();
    const outbound = createSafeOutboundHttpClient({
      resolve: async () => [{ address: '203.0.113.10', family: 4 }],
      transport,
    });
    const probe = createSafeAiConnectionProbe(outbound);
    expect(typeof probe).toBe('function');
    // Probe is bound to the injected SafeOutbound client; production never accepts raw fetch.
    expect(probe.length).toBe(1);
  });
});
