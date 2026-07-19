import {
  type CreatePlatformAuditLogParams,
  type ListPlatformAuditLogParams,
  type PlatformAuditLogItem,
  PlatformAuditLogModel,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

export type { CreatePlatformAuditLogParams, ListPlatformAuditLogParams, PlatformAuditLogItem };

const redactFingerprintFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactFingerprintFields);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.toLowerCase().includes('fingerprint'))
      .map(([key, item]) => [key, redactFingerprintFields(item)]),
  );
};

const toPublicAuditItem = (item: PlatformAuditLogItem): PlatformAuditLogItem => ({
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

  append = async (params: CreatePlatformAuditLogParams): Promise<PlatformAuditLogItem> => {
    return this.model.append(params);
  };

  findById = async (id: string): Promise<PlatformAuditLogItem | undefined> => {
    const item = await this.model.findById(id);
    return item ? toPublicAuditItem(item) : undefined;
  };

  /**
   * Cursor-paginated audit query. Hard-capped by the model (max 200).
   * Unbounded export is intentionally not provided.
   */
  list = async (
    params: ListPlatformAuditLogParams = {},
  ): Promise<{ items: PlatformAuditLogItem[]; nextCursor: string | null }> => {
    const page = await this.model.list(params);
    return { ...page, items: page.items.map(toPublicAuditItem) };
  };
}
