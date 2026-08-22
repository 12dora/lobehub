import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLATFORM_DOCUMENT_RENDER_SETTINGS,
  DOCUMENT_RENDER_DEFAULTS,
  DOCUMENT_RENDER_SETTING_MAXIMA,
  normalizeDocumentRenderSettings,
  platformDocumentRenderSettingsSchema,
} from './documentRenderSettings';

describe('normalizeDocumentRenderSettings', () => {
  it('returns disabled defaults for empty / unknown blobs', () => {
    expect(normalizeDocumentRenderSettings(undefined)).toEqual(
      DEFAULT_PLATFORM_DOCUMENT_RENDER_SETTINGS,
    );
    expect(normalizeDocumentRenderSettings(null)).toEqual({ enabled: false });
    expect(normalizeDocumentRenderSettings({ enabled: 'yes' })).toEqual({ enabled: false });
  });

  it('keeps only well-formed override fields', () => {
    expect(
      normalizeDocumentRenderSettings({
        concurrency: 4.9,
        contactSheetCols: 3,
        contactSheetRows: 4,
        enabled: true,
        endpoint: ' http://document-render:3000 ',
        extra: 'drop-me',
        longEdgePx: 1800,
        maxDocsPerRequest: 2,
        maxFileBytes: 32 * 1024 * 1024,
        maxImagesDefault: 6,
        maxPages: 200,
        mediaThresholdT2: 3,
        pptxAlwaysT2: false,
        retentionDays: 0,
        thumbEdgePx: 512,
        tilesForDensePages: true,
        timeoutSec: 120,
        trigger: 'onDemand',
      }),
    ).toEqual({
      concurrency: 4,
      contactSheetCols: 3,
      contactSheetRows: 4,
      enabled: true,
      endpoint: 'http://document-render:3000',
      longEdgePx: 1800,
      maxDocsPerRequest: 2,
      maxFileBytes: 32 * 1024 * 1024,
      maxImagesDefault: 6,
      maxPages: 200,
      mediaThresholdT2: 3,
      pptxAlwaysT2: false,
      retentionDays: 0,
      thumbEdgePx: 512,
      tilesForDensePages: true,
      timeoutSec: 120,
      trigger: 'onDemand',
    });
  });

  it('drops invalid enum, out-of-range numbers, and blank endpoint', () => {
    expect(
      normalizeDocumentRenderSettings({
        contactSheetCols: 9,
        enabled: true,
        endpoint: '   ',
        longEdgePx: 64,
        retentionDays: -1,
        trigger: 'always',
      }),
    ).toEqual({ enabled: true });
  });

  it('drops values above schema maxima', () => {
    expect(
      normalizeDocumentRenderSettings({
        concurrency: DOCUMENT_RENDER_SETTING_MAXIMA.concurrency + 1,
        enabled: true,
        maxDocsPerRequest: DOCUMENT_RENDER_SETTING_MAXIMA.maxDocsPerRequest + 1,
        maxFileBytes: DOCUMENT_RENDER_SETTING_MAXIMA.maxFileBytes + 1,
        maxImagesDefault: DOCUMENT_RENDER_SETTING_MAXIMA.maxImagesDefault + 1,
        maxPages: DOCUMENT_RENDER_SETTING_MAXIMA.maxPages + 1,
        timeoutSec: DOCUMENT_RENDER_SETTING_MAXIMA.timeoutSec + 1,
      }),
    ).toEqual({ enabled: true });
  });

  it('keeps values at schema maxima', () => {
    expect(
      normalizeDocumentRenderSettings({
        concurrency: DOCUMENT_RENDER_SETTING_MAXIMA.concurrency,
        enabled: true,
        maxDocsPerRequest: DOCUMENT_RENDER_SETTING_MAXIMA.maxDocsPerRequest,
        maxFileBytes: DOCUMENT_RENDER_SETTING_MAXIMA.maxFileBytes,
        maxImagesDefault: DOCUMENT_RENDER_SETTING_MAXIMA.maxImagesDefault,
        maxPages: DOCUMENT_RENDER_SETTING_MAXIMA.maxPages,
        timeoutSec: DOCUMENT_RENDER_SETTING_MAXIMA.timeoutSec,
      }),
    ).toMatchObject({
      concurrency: 8,
      maxDocsPerRequest: 5,
      maxFileBytes: 256 * 1024 * 1024,
      maxImagesDefault: 20,
      maxPages: 1000,
      timeoutSec: 900,
    });
  });
});

describe('platformDocumentRenderSettingsSchema', () => {
  it('accepts a disabled document', () => {
    expect(platformDocumentRenderSettingsSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
  });

  it('accepts DOCUMENT_RENDER_DEFAULTS overlays with enabled', () => {
    expect(
      platformDocumentRenderSettingsSchema.parse({
        enabled: true,
        ...DOCUMENT_RENDER_DEFAULTS,
      }),
    ).toMatchObject({
      enabled: true,
      trigger: 'onUpload',
    });
  });

  it('rejects an unknown trigger', () => {
    const result = platformDocumentRenderSettingsSchema.safeParse({
      enabled: true,
      trigger: 'always',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const result = platformDocumentRenderSettingsSchema.safeParse({
      enabled: false,
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects values above schema maxima', () => {
    expect(
      platformDocumentRenderSettingsSchema.safeParse({
        concurrency: 9,
        enabled: true,
      }).success,
    ).toBe(false);
    expect(
      platformDocumentRenderSettingsSchema.safeParse({
        enabled: true,
        maxPages: 1001,
      }).success,
    ).toBe(false);
    expect(
      platformDocumentRenderSettingsSchema.safeParse({
        enabled: true,
        timeoutSec: 901,
      }).success,
    ).toBe(false);
  });
});
