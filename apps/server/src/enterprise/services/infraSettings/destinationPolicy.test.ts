// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertInfraDestinationAllowed,
  InfraSettingsDestinationError,
  resolveInfraOutboundMode,
} from './destinationPolicy';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveInfraOutboundMode', () => {
  it('defaults to allow-private and tightens only on explicit 0', () => {
    expect(resolveInfraOutboundMode({})).toBe('allow-private');
    expect(resolveInfraOutboundMode({ SSRF_ALLOW_PRIVATE_IP_ADDRESS: '1' })).toBe('allow-private');
    expect(resolveInfraOutboundMode({ SSRF_ALLOW_PRIVATE_IP_ADDRESS: '0' })).toBe('public-only');
  });
});

describe('assertInfraDestinationAllowed', () => {
  it('always denies cloud metadata literals', async () => {
    await expect(
      assertInfraDestinationAllowed({ url: 'http://169.254.169.254/latest/meta-data' }),
    ).rejects.toBeInstanceOf(InfraSettingsDestinationError);
    await expect(
      assertInfraDestinationAllowed({ url: 'http://metadata.google.internal/computeMetadata/v1/' }),
    ).rejects.toMatchObject({ field: 'endpoint' });
  });

  it('denies the entire 169.254/16 range even in allow-private', async () => {
    await expect(
      assertInfraDestinationAllowed(
        { url: 'http://169.254.1.1/' },
        { env: { SSRF_ALLOW_PRIVATE_IP_ADDRESS: '1' } },
      ),
    ).rejects.toBeInstanceOf(InfraSettingsDestinationError);
  });

  it('denies loopback under public-only and allows it when private networks are on', async () => {
    await expect(
      assertInfraDestinationAllowed(
        { host: '127.0.0.1', port: 587 },
        { env: { SSRF_ALLOW_PRIVATE_IP_ADDRESS: '0' }, field: 'host' },
      ),
    ).rejects.toMatchObject({ field: 'host' });

    await expect(
      assertInfraDestinationAllowed(
        { url: 'https://127.0.0.1:9000' },
        { env: { SSRF_ALLOW_PRIVATE_IP_ADDRESS: '1' } },
      ),
    ).resolves.toBeUndefined();
  });

  it('denies a hostname that resolves to metadata (save/probe-time DNS check)', async () => {
    await expect(
      assertInfraDestinationAllowed(
        { url: 'https://minio.internal.example' },
        {
          resolve: async () => [{ address: '169.254.169.254', family: 4 }],
        },
      ),
    ).rejects.toBeInstanceOf(InfraSettingsDestinationError);
  });
});
