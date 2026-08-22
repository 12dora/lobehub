import { describe, expect, it } from 'vitest';

import type { AdminSystemDocumentRenderSettings } from '@/enterprise/client/services/adminSystem';

import {
  bytesToMib,
  toDocumentRenderConfig,
  toDocumentRenderDraft,
  validateDocumentRenderDraft,
} from './documentRenderDraft';

const view = (
  overrides: Partial<AdminSystemDocumentRenderSettings['config']> = {},
): AdminSystemDocumentRenderSettings => ({
  config: {
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
    thumbEdgePx: 512,
    tilesForDensePages: true,
    timeoutSec: 120,
    trigger: 'onUpload',
    ...overrides,
  },
  enabled: false,
  moduleEnabled: true,
  revision: 0,
  source: 'env',
});

describe('documentRenderDraft', () => {
  it('round-trips the effective view into an enabled config', () => {
    const draft = toDocumentRenderDraft(view());
    expect(validateDocumentRenderDraft(draft)).toEqual({});
    expect(toDocumentRenderConfig(draft, true)).toEqual({
      concurrency: 2,
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
      pptxAlwaysT2: true,
      retentionDays: 0,
      thumbEdgePx: 512,
      tilesForDensePages: true,
      timeoutSec: 120,
      trigger: 'onUpload',
    });
  });

  it('edits the size limit in MiB and writes it back in bytes', () => {
    const draft = toDocumentRenderDraft(view());
    expect(draft.maxFileBytesMib).toBe('32');
    draft.maxFileBytesMib = '48';
    expect(toDocumentRenderConfig(draft, true).maxFileBytes).toBe(48 * 1024 * 1024);
  });

  it('keeps a non-round environment size legible', () => {
    expect(bytesToMib(20_000_000)).toBe('19.07');
  });

  /** Empty is not "invalid" — it hands the address back to the environment variable. */
  it('accepts an empty endpoint and omits it from the payload', () => {
    const draft = toDocumentRenderDraft(view());
    draft.endpoint = '  ';
    expect(validateDocumentRenderDraft(draft)).toEqual({});
    expect(toDocumentRenderConfig(draft, true)).not.toHaveProperty('endpoint');
  });

  it('rejects a non-http endpoint', () => {
    const draft = toDocumentRenderDraft(view());
    draft.endpoint = 'document-render:3000';
    expect(validateDocumentRenderDraft(draft)).toEqual({ endpoint: 'url' });
  });

  it('names the bound that was broken rather than a generic positive-integer error', () => {
    const draft = toDocumentRenderDraft(view());
    draft.contactSheetCols = '9';
    draft.contactSheetRows = '0';
    draft.longEdgePx = '100';
    draft.thumbEdgePx = '4000';
    draft.retentionDays = '-1';
    draft.concurrency = '';
    expect(validateDocumentRenderDraft(draft)).toEqual({
      concurrency: 'positiveInt',
      contactSheetCols: 'contactSheetCols',
      contactSheetRows: 'contactSheetRows',
      longEdgePx: 'longEdgePx',
      retentionDays: 'nonNegativeInt',
      thumbEdgePx: 'thumbEdgePx',
    });
  });

  it('accepts a zero retention (artifacts live with the file)', () => {
    const draft = toDocumentRenderDraft(view({ retentionDays: 0 }));
    expect(validateDocumentRenderDraft(draft)).toEqual({});
    expect(toDocumentRenderConfig(draft, true).retentionDays).toBe(0);
  });

  it('reverts to the environment with nothing but the switch', () => {
    expect(toDocumentRenderConfig(toDocumentRenderDraft(view()), false)).toEqual({
      enabled: false,
    });
  });

  it('renders an unset endpoint as an empty field', () => {
    expect(toDocumentRenderDraft(view({ endpoint: null })).endpoint).toBe('');
  });
});
