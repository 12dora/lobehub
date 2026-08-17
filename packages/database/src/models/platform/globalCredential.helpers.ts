import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
  PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES,
  type PlatformGlobalCredentialItem,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import {
  PlatformGlobalCredentialFileTooLargeError,
  PlatformGlobalCredentialValidationError,
} from './globalCredential.errors';
import type { PlatformGlobalCredentialPublicView } from './globalCredential.types';

export const KEY_PATTERN = /^[\w-]+$/;

export const toPublicView = (
  row: PlatformGlobalCredentialItem,
): PlatformGlobalCredentialPublicView => {
  const meta = row.meta ?? {};
  return {
    createdAt: row.createdAt,
    createdBy: row.createdBy ?? null,
    description: meta.description,
    enabled: row.enabled,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    id: row.id,
    key: row.key,
    maskedPreview: meta.maskedPreview,
    name: row.name,
    revision: row.revision,
    type: row.type,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ?? null,
    valueKeys: meta.valueKeys,
  };
};

/** Assert file size against the 256 KiB platform limit. */
export const assertPlatformGlobalCredentialFileSize = (byteLength: number): void => {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    throw new PlatformGlobalCredentialValidationError('File size must be a positive integer');
  }
  if (byteLength > PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES) {
    throw new PlatformGlobalCredentialFileTooLargeError();
  }
};

/**
 * Repair `platform_global_credentials_id_seq` after restore/import (DB-012).
 *
 * Serial PKs require the sequence to sit at `max(id)` or the next INSERT collides.
 * Call from restore runbooks and integration tests. Idempotent.
 *
 * Operator docs: `docs/self-hosting/advanced/database-restore-sequence-repair.md`
 *
 * Equivalent SQL:
 * ```sql
 * SELECT setval(
 *   pg_get_serial_sequence('platform_global_credentials', 'id'),
 *   COALESCE((SELECT MAX(id) FROM platform_global_credentials), 1),
 *   (SELECT MAX(id) IS NOT NULL FROM platform_global_credentials)
 * );
 * ```
 */
export const repairPlatformGlobalCredentialIdSequence = async (
  db: LobeChatDatabase | Transaction,
): Promise<{ maxId: number; nextVal: number }> => {
  const result = await db.execute(sql`
    SELECT setval(
      pg_get_serial_sequence('platform_global_credentials', 'id'),
      COALESCE((SELECT MAX(id) FROM platform_global_credentials), 1),
      (SELECT MAX(id) IS NOT NULL FROM platform_global_credentials)
    ) AS next_val,
    COALESCE((SELECT MAX(id) FROM platform_global_credentials), 0) AS max_id
  `);
  const rows =
    (result as unknown as { rows?: Array<{ max_id: string | number; next_val: string | number }> })
      .rows ??
    (Array.isArray(result)
      ? (result as Array<{ max_id: string | number; next_val: string | number }>)
      : []);
  const row = rows[0];
  return {
    maxId: Number(row?.max_id ?? 0),
    nextVal: Number(row?.next_val ?? 1),
  };
};

export const fingerprintPayload = (payload: string | Uint8Array): string => {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  return createHash('sha256').update(buf).digest('hex');
};
