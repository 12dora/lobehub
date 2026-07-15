import {
  type CreatePlatformAuditLogParams,
  type ListPlatformAuditLogParams,
  type PlatformAuditLogItem,
  PlatformAuditLogModel,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

export type { CreatePlatformAuditLogParams, ListPlatformAuditLogParams, PlatformAuditLogItem };

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
    return this.model.findById(id);
  };

  /**
   * Cursor-paginated audit query. Hard-capped by the model (max 200).
   * Unbounded export is intentionally not provided.
   */
  list = async (
    params: ListPlatformAuditLogParams = {},
  ): Promise<{ items: PlatformAuditLogItem[]; nextCursor: string | null }> => {
    return this.model.list(params);
  };
}
