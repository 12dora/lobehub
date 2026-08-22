import { z } from 'zod';

/**
 * Platform-level document-render (Gotenberg sidecar) settings (single logical row).
 *
 * When `enabled` is false (or the row is absent) the process environment is the
 * source of truth. When `enabled` is true, each stored field overrides the matching
 * env value (`DB ?? env`). See docs/enterprise/office-documents-multimodal-design.md §6.2.
 */

export const DOCUMENT_RENDER_TRIGGERS = ['onUpload', 'onDemand'] as const;
export type DocumentRenderTrigger = (typeof DOCUMENT_RENDER_TRIGGERS)[number];

export interface PlatformDocumentRenderSettings {
  /** Contact-sheet grid columns (default 3). */
  contactSheetCols?: number;
  /** Contact-sheet grid rows (default 4). */
  contactSheetRows?: number;
  /** Worker concurrency for render jobs (default 2). */
  concurrency?: number;
  /** When false, env owns every field. When true, stored fields override env. */
  enabled: boolean;
  /** Gotenberg base URL, e.g. `http://document-render:3000`. */
  endpoint?: string;
  /** Full-page long edge in px (default 1800). */
  longEdgePx?: number;
  /** Documents that may contribute page images per request (default 2). */
  maxDocsPerRequest?: number;
  /** Skip rendering above this size (default 32 MiB). */
  maxFileBytes?: number;
  /** Default per-request image cap; endpoint table may lower it (default 6). */
  maxImagesDefault?: number;
  /** Render at most this many pages (default 200). */
  maxPages?: number;
  /** docx/xlsx media count at or above which the file goes to T2 (default 3). */
  mediaThresholdT2?: number;
  /** pptx always goes to T2 full-page render (default true). */
  pptxAlwaysT2?: boolean;
  /** Artifact retention in days; 0 = live with the file (default 0). */
  retentionDays?: number;
  /** Thumbnail long edge in px (default 512). */
  thumbEdgePx?: number;
  /** Store 2×2 zoom tiles for dense pages (default true). */
  tilesForDensePages?: boolean;
  /** Single render-job timeout in seconds (default 120). */
  timeoutSec?: number;
  /** When to render: on upload (default) or on first demand. */
  trigger?: DocumentRenderTrigger;
}

export const DEFAULT_PLATFORM_DOCUMENT_RENDER_SETTINGS: PlatformDocumentRenderSettings = {
  enabled: false,
};

/** Effective defaults used when neither DB nor env provide a value. */
export const DOCUMENT_RENDER_DEFAULTS = {
  concurrency: 2,
  contactSheetCols: 3,
  contactSheetRows: 4,
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
  trigger: 'onUpload' as DocumentRenderTrigger,
} as const;

const optionalPositiveInt = z.number().int().positive().optional();
const optionalNonNegativeInt = z.number().int().nonnegative().optional();

export const platformDocumentRenderSettingsFields = {
  concurrency: optionalPositiveInt,
  contactSheetCols: z.number().int().min(1).max(6).optional(),
  contactSheetRows: z.number().int().min(1).max(8).optional(),
  enabled: z.boolean(),
  endpoint: z.string().trim().max(512).optional(),
  longEdgePx: z.number().int().min(256).max(4096).optional(),
  maxDocsPerRequest: optionalPositiveInt,
  maxFileBytes: optionalPositiveInt,
  maxImagesDefault: optionalPositiveInt,
  maxPages: optionalPositiveInt,
  mediaThresholdT2: optionalPositiveInt,
  pptxAlwaysT2: z.boolean().optional(),
  retentionDays: optionalNonNegativeInt,
  thumbEdgePx: z.number().int().min(128).max(1024).optional(),
  tilesForDensePages: z.boolean().optional(),
  timeoutSec: optionalPositiveInt,
  trigger: z.enum(DOCUMENT_RENDER_TRIGGERS).optional(),
};

export const platformDocumentRenderSettingsSchema = z
  .object(platformDocumentRenderSettingsFields)
  .strict();

const asOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asOptionalInt = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.trunc(value);
  return rounded >= min && rounded <= max ? rounded : undefined;
};

const asOptionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** Coerce an unknown jsonb blob into a stored document-render settings document. */
export const normalizeDocumentRenderSettings = (
  value: unknown,
): PlatformDocumentRenderSettings => {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const next: PlatformDocumentRenderSettings = { enabled: raw.enabled === true };

  const endpoint = asOptionalString(raw.endpoint);
  if (endpoint) next.endpoint = endpoint;
  if (raw.trigger === 'onUpload' || raw.trigger === 'onDemand') next.trigger = raw.trigger;

  const ints: Array<[keyof PlatformDocumentRenderSettings, number, number?]> = [
    ['concurrency', 1],
    ['contactSheetCols', 1, 6],
    ['contactSheetRows', 1, 8],
    ['longEdgePx', 256, 4096],
    ['maxDocsPerRequest', 1],
    ['maxFileBytes', 1],
    ['maxImagesDefault', 1],
    ['maxPages', 1],
    ['mediaThresholdT2', 1],
    ['retentionDays', 0],
    ['thumbEdgePx', 128, 1024],
    ['timeoutSec', 1],
  ];
  for (const [key, min, max] of ints) {
    const parsed = asOptionalInt(raw[key], min, max);
    if (parsed !== undefined) (next as unknown as Record<string, unknown>)[key] = parsed;
  }

  const pptxAlwaysT2 = asOptionalBoolean(raw.pptxAlwaysT2);
  if (pptxAlwaysT2 !== undefined) next.pptxAlwaysT2 = pptxAlwaysT2;
  const tilesForDensePages = asOptionalBoolean(raw.tilesForDensePages);
  if (tilesForDensePages !== undefined) next.tilesForDensePages = tilesForDensePages;

  return next;
};
