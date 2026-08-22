// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformDocumentRenderSettingsModel } from '@/database/models/platform/documentRenderSettings';
import { platformDocumentRenderSettings } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { DOCUMENT_RENDER_DEFAULTS } from '@/types/platform/documentRenderSettings';

import {
  getEffectiveDocumentRenderSettings,
  invalidateEffectiveDocumentRenderSettings,
  isDocumentRenderConfigured,
  mergeDocumentRenderSettings,
  resetEffectiveDocumentRenderSettingsForTest,
  settingsFromEnv,
} from './effective';

const db: LobeChatDatabase = await getTestDB();

const env = {
  DOCUMENT_RENDER_CONCURRENCY: 3,
  DOCUMENT_RENDER_LONG_EDGE_PX: 1600,
  DOCUMENT_RENDER_MAX_FILE_BYTES: 16 * 1024 * 1024,
  DOCUMENT_RENDER_MAX_PAGES: 50,
  DOCUMENT_RENDER_THUMB_EDGE_PX: 256,
  DOCUMENT_RENDER_TIMEOUT_SEC: 90,
  DOCUMENT_RENDER_TRIGGER: 'onDemand' as const,
  DOCUMENT_RENDER_URL: 'http://gotenberg:3000',
};

beforeEach(async () => {
  resetEffectiveDocumentRenderSettingsForTest();
  await db.delete(platformDocumentRenderSettings);
});

afterEach(async () => {
  resetEffectiveDocumentRenderSettingsForTest();
  await db.delete(platformDocumentRenderSettings);
});

describe('mergeDocumentRenderSettings', () => {
  it('uses env (then DOCUMENT_RENDER_DEFAULTS) when the stored row is not enabled', () => {
    const effective = mergeDocumentRenderSettings(env, {
      enabled: false,
      endpoint: 'http://ignored:1',
      maxPages: 9,
      revision: 3,
    });
    expect(effective).toMatchObject({
      concurrency: 3,
      contactSheetCols: DOCUMENT_RENDER_DEFAULTS.contactSheetCols,
      endpoint: 'http://gotenberg:3000',
      maxPages: 50,
      pptxAlwaysT2: DOCUMENT_RENDER_DEFAULTS.pptxAlwaysT2,
      revision: 3,
      source: 'env',
      trigger: 'onDemand',
    });
  });

  it('overrides env with stored fields when enabled (DB ?? env ?? defaults)', () => {
    const effective = mergeDocumentRenderSettings(env, {
      enabled: true,
      endpoint: 'http://custom:3000',
      maxPages: 12,
      pptxAlwaysT2: false,
      revision: 2,
    });
    expect(effective).toMatchObject({
      concurrency: 3,
      endpoint: 'http://custom:3000',
      maxPages: 12,
      pptxAlwaysT2: false,
      source: 'db',
      timeoutSec: 90,
    });
  });

  it('fills DOCUMENT_RENDER_DEFAULTS when neither DB nor env provide a value', () => {
    const effective = mergeDocumentRenderSettings({}, { enabled: false, revision: 0 });
    expect(effective).toEqual({
      ...DOCUMENT_RENDER_DEFAULTS,
      revision: 0,
      source: 'env',
    });
    expect(effective.endpoint).toBeUndefined();
  });
});

describe('isDocumentRenderConfigured', () => {
  it('is true only when an endpoint is present', () => {
    expect(isDocumentRenderConfigured(settingsFromEnv({}))).toBe(false);
    expect(isDocumentRenderConfigured(settingsFromEnv(env))).toBe(true);
  });
});

describe('getEffectiveDocumentRenderSettings', () => {
  it('returns env values when no row exists', async () => {
    const effective = await getEffectiveDocumentRenderSettings({ db, env });
    expect(effective).toEqual(settingsFromEnv(env));
    expect(effective.source).toBe('env');
  });

  it('applies a saved DB override', async () => {
    await new PlatformDocumentRenderSettingsModel(db).update('admin', {
      concurrency: 1,
      enabled: true,
      endpoint: 'http://override:3000',
      expectedRevision: 0,
      trigger: 'onUpload',
    });

    const effective = await getEffectiveDocumentRenderSettings({ db, env });
    expect(effective.source).toBe('db');
    expect(effective.endpoint).toBe('http://override:3000');
    expect(effective.concurrency).toBe(1);
    expect(effective.maxPages).toBe(50);
    expect(effective.trigger).toBe('onUpload');
  });

  it('caches until invalidateEffectiveDocumentRenderSettings', async () => {
    await getEffectiveDocumentRenderSettings({ db, env });
    await new PlatformDocumentRenderSettingsModel(db).update('admin', {
      enabled: true,
      endpoint: 'http://cached:3000',
      expectedRevision: 0,
    });
    const cached = await getEffectiveDocumentRenderSettings({ db, env });
    expect(cached.endpoint).toBe('http://gotenberg:3000');
    expect(cached.source).toBe('env');

    invalidateEffectiveDocumentRenderSettings();
    const next = await getEffectiveDocumentRenderSettings({ db, env });
    expect(next.endpoint).toBe('http://cached:3000');
    expect(next.source).toBe('db');
  });

  it('fails open to env when the database throws', async () => {
    const broken = {
      select: () => {
        throw new Error('db down');
      },
    } as never;
    const effective = await getEffectiveDocumentRenderSettings({ db: broken, env });
    expect(effective).toEqual(settingsFromEnv(env));
    expect(effective.source).toBe('env');
  });
});
