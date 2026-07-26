import {
  type CreatePlatformAuditLogParams,
  type ListPlatformAuditLogParams,
  type PlatformAuditLogItem,
  PlatformAuditLogModel,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { AuditAction, AuditTargetType } from './audit/auditActionCatalog';

export type { CreatePlatformAuditLogParams, ListPlatformAuditLogParams, PlatformAuditLogItem };

/** Typed append payload: action/targetType must come from the server audit catalogs. */
export type AppendPlatformAuditLogParams = Omit<
  CreatePlatformAuditLogParams,
  'action' | 'targetType'
> & {
  action: AuditAction;
  targetType: AuditTargetType;
};

const redactFingerprintFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactFingerprintFields);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.toLowerCase().includes('fingerprint'))
      .map(([key, item]) => [key, redactFingerprintFields(item)]),
  );
};

/**
 * Canonical projection for every audit row that crosses a public admin/export boundary.
 * Legacy or directly inserted rows may predate write-time sanitization, so callers must
 * not project stored diffs themselves.
 */
export const toPublicPlatformAuditItem = (item: PlatformAuditLogItem): PlatformAuditLogItem => ({
  ...item,
  afterDiff: redactFingerprintFields(item.afterDiff) as Record<string, unknown> | null,
  beforeDiff: redactFingerprintFields(item.beforeDiff) as Record<string, unknown> | null,
});

/**
 * Server-side audit service.
 * Always redacts diffs before write (delegated to PlatformAuditLogModel).
 * Append-only: no update/delete API is exposed here.
 */
export class PlatformAuditService {
  private readonly model: PlatformAuditLogModel;

  constructor(db: LobeChatDatabase | Transaction) {
    this.model = new PlatformAuditLogModel(db);
  }

  /**
   * Centralized, sanitized observability when a denial-audit append fails.
   * Callers must not invent per-router silence knobs or log schemas.
   */
  static logDeniedAuditAppendFailure = (error: unknown, action: string): void => {
    console.error('[admin.reauth] reauth denied audit failed', {
      action,
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
  };

  append(params: AppendPlatformAuditLogParams): Promise<PlatformAuditLogItem> {
    return this.model.append(params);
  }

  findById = async (id: string): Promise<PlatformAuditLogItem | undefined> => {
    const item = await this.model.findById(id);
    return item ? toPublicPlatformAuditItem(item) : undefined;
  };

  /**
   * Cursor-paginated audit query. Hard-capped by the model (max 200).
   * Unbounded export is intentionally not provided.
   */
  list = async (
    params: ListPlatformAuditLogParams = {},
  ): Promise<{ items: PlatformAuditLogItem[]; nextCursor: string | null }> => {
    const page = await this.model.list(params);
    return { ...page, items: page.items.map(toPublicPlatformAuditItem) };
  };
}
