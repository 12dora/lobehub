// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { SafeOutboundHttpClient } from './index';
import type { DnsResolver, PinnedTransport, PinnedTransportResponse } from './types';

const okResponse = (overrides: Partial<PinnedTransportResponse> = {}): PinnedTransportResponse => ({
  body: Buffer.from('{"ok":true}'),
  headers: { 'content-type': 'application/json' },
  status: 200,
  statusText: 'OK',
  ...overrides,
});

const resolveTo =
  (entries: { address: string; family?: 4 | 6 }[]): DnsResolver =>
  async () =>
    entries.map((e) => ({ address: e.address, family: e.family ?? 4 }));

describe('SafeOutboundHttpClient allowlist mode', () => {
  it('blocks hosts not on the allowlist', async () => {
    const client = new SafeOutboundHttpClient({
      mode: 'allowlist',
      allowlist: ['allowed.example'],
      resolve: resolveTo([{ address: '1.2.3.4' }]),
      transport: vi.fn(),
    });
    await expect(client.fetch('https://other.example/')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
  });

  it('allows allowlisted host after DNS pin', async () => {
    const transport = vi.fn<PinnedTransport>(async (req) => {
      expect(req.pinnedAddress).toBe('9.9.9.9');
      return okResponse({ body: Buffer.from('allowlisted') });
    });
    const client = new SafeOutboundHttpClient({
      mode: 'allowlist',
      allowlist: ['allowed.example'],
      resolve: resolveTo([{ address: '9.9.9.9' }]),
      transport,
    });
    const res = await client.fetch('https://allowed.example/api');
    expect(await res.text()).toBe('allowlisted');
  });

  it('still blocks metadata even if listed in allowlist', async () => {
    const client = new SafeOutboundHttpClient({
      mode: 'allowlist',
      allowlist: ['169.254.169.254', 'metadata.google.internal'],
      transport: vi.fn(),
    });
    await expect(client.fetch('http://169.254.169.254/')).rejects.toThrow(/metadata/i);
    await expect(client.fetch('http://metadata.google.internal/')).rejects.toThrow(/metadata/i);
  });

  it('blocks allowlisted hostname that resolves to metadata', async () => {
    const client = new SafeOutboundHttpClient({
      mode: 'allowlist',
      allowlist: ['sneaky.example'],
      resolve: resolveTo([{ address: '169.254.169.254' }]),
      transport: vi.fn(),
    });
    await expect(client.fetch('https://sneaky.example/')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
    });
  });
});
