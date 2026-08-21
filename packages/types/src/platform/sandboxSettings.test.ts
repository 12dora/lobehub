import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLATFORM_SANDBOX_SETTINGS,
  normalizeSandboxSettings,
  platformSandboxSettingsSchema,
} from './sandboxSettings';

describe('normalizeSandboxSettings', () => {
  it('returns disabled defaults for empty / unknown blobs', () => {
    expect(normalizeSandboxSettings(undefined)).toEqual(DEFAULT_PLATFORM_SANDBOX_SETTINGS);
    expect(normalizeSandboxSettings(null)).toEqual({ enabled: false });
    expect(normalizeSandboxSettings({ enabled: 'yes' })).toEqual({ enabled: false });
  });

  it('keeps only well-formed override fields', () => {
    expect(
      normalizeSandboxSettings({
        cpus: 2.5,
        dockerHost: ' tcp://127.0.0.1:2375 ',
        dockerSocket: '/var/run/docker.sock',
        enabled: true,
        idleTtlSec: 60.9,
        image: ' ai-sandbox:1 ',
        maxContainers: 4,
        maxOutputBytes: 4096,
        memoryMb: 512,
        network: 'none',
        pidsLimit: 128,
        provider: 'local',
        pullPolicy: 'never',
        timeoutMs: 5000,
        extra: 'drop-me',
      }),
    ).toEqual({
      cpus: 2.5,
      dockerHost: 'tcp://127.0.0.1:2375',
      dockerSocket: '/var/run/docker.sock',
      enabled: true,
      idleTtlSec: 60,
      image: 'ai-sandbox:1',
      maxContainers: 4,
      maxOutputBytes: 4096,
      memoryMb: 512,
      network: 'none',
      pidsLimit: 128,
      provider: 'local',
      pullPolicy: 'never',
      timeoutMs: 5000,
    });
  });

  it('drops invalid enum and non-positive numbers', () => {
    expect(
      normalizeSandboxSettings({
        cpus: 0,
        enabled: true,
        memoryMb: -1,
        network: 'host',
        provider: 'e2b',
        pullPolicy: 'sometimes',
      }),
    ).toEqual({ enabled: true });
  });
});

describe('platformSandboxSettingsSchema', () => {
  it('accepts a disabled document', () => {
    expect(platformSandboxSettingsSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('rejects an unknown provider', () => {
    const result = platformSandboxSettingsSchema.safeParse({ enabled: true, provider: 'e2b' });
    expect(result.success).toBe(false);
  });
});
