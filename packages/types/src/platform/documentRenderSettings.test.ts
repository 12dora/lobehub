import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLATFORM_DOCUMENT_RENDER_SETTINGS,
  DOCUMENT_RENDER_DEFAULTS,
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
});
