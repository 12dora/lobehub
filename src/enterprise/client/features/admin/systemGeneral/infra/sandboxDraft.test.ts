import { describe, expect, it } from 'vitest';

import type { AdminSystemSandboxSettings } from '@/enterprise/client/services/adminSystem';

import { toSandboxConfig, toSandboxDraft, validateSandboxDraft } from './sandboxDraft';

const view = (overrides: Partial<AdminSystemSandboxSettings> = {}): AdminSystemSandboxSettings => ({
  cpus: 1,
  dockerHost: null,
  dockerSocket: '/var/run/docker.sock',
  enabled: false,
  idleTtlSec: 1800,
  image: 'aihub-sandbox:latest',
  maxContainers: 8,
  maxOutputBytes: 1_048_576,
  memoryMb: 1024,
  moduleEnabled: true,
  network: 'bridge',
  pidsLimit: 256,
  provider: 'local',
  pullPolicy: 'if-missing',
  revision: 0,
  source: 'env',
  timeoutMs: 120_000,
  ...overrides,
});

describe('sandboxDraft', () => {
  it('round-trips a local view into an enabled config', () => {
    const draft = toSandboxDraft(view());
    expect(validateSandboxDraft(draft)).toEqual({});
    expect(toSandboxConfig(draft, true)).toMatchObject({
      dockerSocket: '/var/run/docker.sock',
      enabled: true,
      image: 'aihub-sandbox:latest',
      provider: 'local',
    });
  });

  it('requires local numeric fields when provider is local', () => {
    const draft = toSandboxDraft(view());
    draft.memoryMb = '0';
    draft.image = ' ';
    expect(validateSandboxDraft(draft)).toEqual({
      image: 'required',
      memoryMb: 'positiveInt',
    });
  });

  it('skips local field checks for market / onlyboxes', () => {
    const draft = toSandboxDraft(view({ provider: 'market' }));
    draft.image = '';
    expect(validateSandboxDraft(draft)).toEqual({});
    expect(toSandboxConfig(draft, true)).toEqual({ enabled: true, provider: 'market' });
  });

  it('disables without requiring local fields', () => {
    expect(toSandboxConfig(toSandboxDraft(view()), false)).toEqual({ enabled: false });
  });
});
