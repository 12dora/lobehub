// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDocumentRenderQueueStats,
  probeGotenberg,
} from '@/server/enterprise/services/documentRender';
import { getEffectiveDocumentRenderSettings } from '@/server/enterprise/services/documentRenderSettings';
import { isModuleEnabled } from '@/server/enterprise/services/moduleSettings';

import { probeDocumentRenderHealth, testDocumentRenderDependency } from './documentRenderProbe';

vi.mock('@/server/enterprise/services/moduleSettings', () => ({
  isModuleEnabled: vi.fn(),
}));

vi.mock('@/server/enterprise/services/documentRenderSettings', () => ({
  getEffectiveDocumentRenderSettings: vi.fn(),
  isDocumentRenderConfigured: vi.fn((settings: { endpoint?: string }) =>
    Boolean(settings.endpoint),
  ),
}));

vi.mock('@/server/enterprise/services/documentRender', () => ({
  getDocumentRenderQueueStats: vi.fn(),
  probeGotenberg: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => ({})),
}));

const checkedAt = new Date('2026-08-22T00:00:00.000Z');

const effective = {
  concurrency: 2,
  contactSheetCols: 3,
  contactSheetRows: 4,
  endpoint: 'http://document-render:3000',
  longEdgePx: 1800,
  maxDocsPerRequest: 2,
  maxFileBytes: 32 * 1024 * 1024,
  maxImagesDefault: 6,
  maxPages: 200,
  mediaThresholdT2: 3,
  pptxAlwaysT2: true,
  retentionDays: 0,
  revision: 0,
  source: 'env' as const,
  thumbEdgePx: 512,
  tilesForDensePages: true,
  timeoutSec: 120,
  trigger: 'onUpload' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(getEffectiveDocumentRenderSettings).mockResolvedValue(effective);
  vi.mocked(getDocumentRenderQueueStats).mockResolvedValue({
    avgMs: 100,
    failed24h: 1,
    p95Ms: 200,
    pending: 3,
    recent: [],
    running: 1,
    succeeded24h: 4,
  });
});

describe('probeDocumentRenderHealth', () => {
  it('returns null when the module is off', async () => {
    vi.mocked(isModuleEnabled).mockResolvedValue(false);
    await expect(probeDocumentRenderHealth(() => checkedAt)).resolves.toBeNull();
    expect(probeGotenberg).not.toHaveBeenCalled();
  });

  it('returns degraded unconfigured health when no endpoint is set', async () => {
    vi.mocked(getEffectiveDocumentRenderSettings).mockResolvedValue({
      ...effective,
      endpoint: undefined,
    });
    await expect(probeDocumentRenderHealth(() => checkedAt)).resolves.toMatchObject({
      configured: false,
      errorCategory: 'configuration_incomplete',
      queuePending: 3,
      queueRunning: 1,
      status: 'degraded',
    });
    expect(probeGotenberg).not.toHaveBeenCalled();
  });

  it('returns healthy when Gotenberg answers', async () => {
    vi.mocked(probeGotenberg).mockResolvedValue({
      latencyMs: 18,
      ok: true,
      version: '8.21.0',
    });
    await expect(probeDocumentRenderHealth(() => checkedAt)).resolves.toEqual({
      configured: true,
      errorCategory: null,
      lastCheckedAt: checkedAt,
      latencyMs: 18,
      queuePending: 3,
      queueRunning: 1,
      status: 'healthy',
      version: '8.21.0',
    });
  });

  it('returns unavailable when Gotenberg is down', async () => {
    vi.mocked(probeGotenberg).mockResolvedValue({
      error: 'connect ECONNREFUSED',
      latencyMs: 5,
      ok: false,
    });
    await expect(probeDocumentRenderHealth(() => checkedAt)).resolves.toMatchObject({
      configured: true,
      errorCategory: 'operation_unavailable',
      lastError: 'connect ECONNREFUSED',
      status: 'unavailable',
    });
  });
});

describe('testDocumentRenderDependency', () => {
  it('reports not_configured when the effective endpoint is missing', async () => {
    vi.mocked(getEffectiveDocumentRenderSettings).mockResolvedValue({
      ...effective,
      endpoint: undefined,
    });
    await expect(testDocumentRenderDependency(() => checkedAt)).resolves.toMatchObject({
      message: 'not_configured',
      ok: false,
    });
    expect(probeGotenberg).not.toHaveBeenCalled();
  });

  it('probes Gotenberg at the effective endpoint', async () => {
    vi.mocked(probeGotenberg).mockResolvedValue({ latencyMs: 22, ok: true, version: '8.21.0' });
    await expect(testDocumentRenderDependency(() => checkedAt)).resolves.toEqual({
      checkedAt,
      latencyMs: 22,
      ok: true,
    });
    expect(probeGotenberg).toHaveBeenCalledWith('http://document-render:3000', 5000);
  });
});
