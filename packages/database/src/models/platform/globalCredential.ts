/**
 * Platform-global credentials — no ownership / workspace scope.
 *
 * Public projections never include ciphertext, fingerprint, ref, or plaintext.
 * Envelope material is only returned via internal secret accessors for server
 * services that decrypt in-process.
 */
import { createHash, randomUUID } from 'node:crypto';

import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import {
  type NewPlatformGlobalCredential,
  PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES,
  type PlatformGlobalCredentialItem,
  type PlatformGlobalCredentialMeta,
  platformGlobalCredentials,
  type PlatformGlobalCredentialSecretItem,
  platformGlobalCredentialSecrets,
  type PlatformGlobalCredentialType,
  type PlatformGlobalCredentialUploadItem,
  platformGlobalCredentialUploads,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export class PlatformGlobalCredentialConflictError extends Error {
  readonly code = 'PLATFORM_GLOBAL_CREDENTIAL_CONFLICT';
  constructor(message = 'Credential key already exists') {
    super(message);
    this.name = 'PlatformGlobalCredentialConflictError';
  }
}

export class PlatformGlobalCredentialNotFoundError extends Error {
  readonly code = 'PLATFORM_GLOBAL_CREDENTIAL_NOT_FOUND';
  constructor(message = 'Credential not found') {
    super(message);
    this.name = 'PlatformGlobalCredentialNotFoundError';
  }
}

export class PlatformGlobalCredentialFileTooLargeError extends Error {
  readonly code = 'PLATFORM_GLOBAL_CREDENTIAL_FILE_TOO_LARGE';
  readonly maxBytes = PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES;
  constructor(message = `File exceeds ${PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES} byte limit`) {
    super(message);
    this.name = 'PlatformGlobalCredentialFileTooLargeError';
  }
}

export class PlatformGlobalCredentialValidationError extends Error {
  readonly code = 'PLATFORM_GLOBAL_CREDENTIAL_VALIDATION';
  constructor(message: string) {
    super(message);
    this.name = 'PlatformGlobalCredentialValidationError';
  }
}

/** Public row projection (API / list / get). Never carries secret material. */
export interface PlatformGlobalCredentialPublicView {
  createdAt: Date;
  createdBy: string | null;
  description?: string;
  enabled: boolean;
  fileName?: string;
  fileSize?: number;
  id: number;
  key: string;
  maskedPreview?: string;
  name: string;
  type: PlatformGlobalCredentialType;
  updatedAt: Date;
  updatedBy: string | null;
  valueKeys?: string[];
}

/** Envelope payload accepted by the model (already encrypted by PlatformSecretService). */
export interface PlatformGlobalCredentialEnvelope {
  ciphertext: string;
  fingerprint: string;
  keyId: string;
  ref?: string;
}

export interface CreatePlatformGlobalCredentialParams {
  createdBy?: string | null;
  envelope: PlatformGlobalCredentialEnvelope;
  key: string;
  meta?: PlatformGlobalCredentialMeta;
  name: string;
  type: PlatformGlobalCredentialType;
}

export interface UpdatePlatformGlobalCredentialParams {
  envelope?: PlatformGlobalCredentialEnvelope;
  id: number;
  meta?: PlatformGlobalCredentialMeta;
  name?: string;
  updatedBy?: string | null;
}

export interface StagePlatformGlobalCredentialUploadParams {
  createdBy?: string | null;
  envelope: PlatformGlobalCredentialEnvelope;
  expiresAt: Date;
  fileHashId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
}

const KEY_PATTERN = /^[\w-]+$/;

const toPublicView = (row: PlatformGlobalCredentialItem): PlatformGlobalCredentialPublicView => {
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

export const fingerprintPayload = (payload: string | Uint8Array): string => {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  return createHash('sha256').update(buf).digest('hex');
};

export class PlatformGlobalCredentialModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  private readonly inTransaction = async <T>(callback: (tx: Transaction) => Promise<T>) => {
    const database = this.db as LobeChatDatabase;
    return typeof database.transaction === 'function'
      ? database.transaction(callback)
      : callback(this.db as Transaction);
  };

  list = async (): Promise<PlatformGlobalCredentialPublicView[]> => {
    const rows = await this.db
      .select()
      .from(platformGlobalCredentials)
      .orderBy(asc(platformGlobalCredentials.key));
    return rows.map(toPublicView);
  };

  getById = async (id: number): Promise<PlatformGlobalCredentialPublicView | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformGlobalCredentials)
      .where(eq(platformGlobalCredentials.id, id))
      .limit(1);
    return row ? toPublicView(row) : undefined;
  };

  getByKey = async (key: string): Promise<PlatformGlobalCredentialPublicView | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformGlobalCredentials)
      .where(eq(platformGlobalCredentials.key, key))
      .limit(1);
    return row ? toPublicView(row) : undefined;
  };

  /**
   * Active (non-revoked) secret envelope for server-side decrypt only.
   * Never expose this return value through admin/public APIs.
   */
  getActiveSecretEnvelope = async (
    credentialId: number,
  ): Promise<Pick<
    PlatformGlobalCredentialSecretItem,
    'ciphertext' | 'fingerprint' | 'keyId' | 'ref' | 'revision'
  > | null> => {
    const [row] = await this.db
      .select({
        ciphertext: platformGlobalCredentialSecrets.ciphertext,
        fingerprint: platformGlobalCredentialSecrets.fingerprint,
        keyId: platformGlobalCredentialSecrets.keyId,
        ref: platformGlobalCredentialSecrets.ref,
        revision: platformGlobalCredentialSecrets.revision,
      })
      .from(platformGlobalCredentialSecrets)
      .where(
        and(
          eq(platformGlobalCredentialSecrets.credentialId, credentialId),
          isNull(platformGlobalCredentialSecrets.revokedAt),
        ),
      )
      .orderBy(sql`${platformGlobalCredentialSecrets.revision} DESC`)
      .limit(1);
    return row ?? null;
  };

  create = async (
    params: CreatePlatformGlobalCredentialParams,
  ): Promise<PlatformGlobalCredentialPublicView> => {
    this.assertKey(params.key);
    this.assertName(params.name);
    this.assertEnvelope(params.envelope);
    if (params.type === 'file') {
      const size = params.meta?.fileSize;
      if (typeof size === 'number') assertPlatformGlobalCredentialFileSize(size);
    }

    return this.inTransaction(async (tx) => {
      let inserted: PlatformGlobalCredentialItem;
      try {
        const [row] = await tx
          .insert(platformGlobalCredentials)
          .values({
            createdBy: params.createdBy ?? null,
            enabled: true,
            key: params.key,
            meta: params.meta ?? {},
            name: params.name,
            type: params.type,
            updatedBy: params.createdBy ?? null,
          } satisfies NewPlatformGlobalCredential)
          .returning();
        if (!row) throw new PlatformGlobalCredentialValidationError('Failed to insert credential');
        inserted = row;
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new PlatformGlobalCredentialConflictError(
            `Credential key already exists: ${params.key}`,
          );
        }
        throw error;
      }

      const ref =
        params.envelope.ref ?? `kms://platform-global-credentials/${inserted.id}/${randomUUID()}`;

      await tx.insert(platformGlobalCredentialSecrets).values({
        ciphertext: params.envelope.ciphertext,
        credentialId: inserted.id,
        fingerprint: params.envelope.fingerprint,
        keyId: params.envelope.keyId,
        ref,
        revision: 1,
      });

      return toPublicView(inserted);
    });
  };

  update = async (
    params: UpdatePlatformGlobalCredentialParams,
  ): Promise<PlatformGlobalCredentialPublicView> => {
    if (params.name !== undefined) this.assertName(params.name);
    if (params.envelope) this.assertEnvelope(params.envelope);
    if (params.meta?.fileSize !== undefined) {
      assertPlatformGlobalCredentialFileSize(params.meta.fileSize);
    }

    return this.inTransaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(platformGlobalCredentials)
        .where(eq(platformGlobalCredentials.id, params.id))
        .for('update');
      if (!existing) throw new PlatformGlobalCredentialNotFoundError();

      const nextMeta: PlatformGlobalCredentialMeta = {
        ...existing.meta,
        ...params.meta,
      };

      const [updated] = await tx
        .update(platformGlobalCredentials)
        .set({
          meta: nextMeta,
          name: params.name ?? existing.name,
          updatedBy: params.updatedBy ?? existing.updatedBy,
        })
        .where(eq(platformGlobalCredentials.id, params.id))
        .returning();
      if (!updated) throw new PlatformGlobalCredentialNotFoundError();

      if (params.envelope) {
        await tx
          .update(platformGlobalCredentialSecrets)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(platformGlobalCredentialSecrets.credentialId, params.id),
              isNull(platformGlobalCredentialSecrets.revokedAt),
            ),
          );

        const [prev] = await tx
          .select({ revision: platformGlobalCredentialSecrets.revision })
          .from(platformGlobalCredentialSecrets)
          .where(eq(platformGlobalCredentialSecrets.credentialId, params.id))
          .orderBy(sql`${platformGlobalCredentialSecrets.revision} DESC`)
          .limit(1);

        const ref =
          params.envelope.ref ?? `kms://platform-global-credentials/${params.id}/${randomUUID()}`;

        await tx.insert(platformGlobalCredentialSecrets).values({
          ciphertext: params.envelope.ciphertext,
          credentialId: params.id,
          fingerprint: params.envelope.fingerprint,
          keyId: params.envelope.keyId,
          ref,
          revision: (prev?.revision ?? 0) + 1,
        });
      }

      return toPublicView(updated);
    });
  };

  deleteById = async (id: number): Promise<boolean> => {
    return this.inTransaction(async (tx) => {
      const deleted = await tx
        .delete(platformGlobalCredentials)
        .where(eq(platformGlobalCredentials.id, id))
        .returning({ id: platformGlobalCredentials.id });
      return deleted.length > 0;
    });
  };

  deleteByKey = async (key: string): Promise<boolean> => {
    return this.inTransaction(async (tx) => {
      const deleted = await tx
        .delete(platformGlobalCredentials)
        .where(eq(platformGlobalCredentials.key, key))
        .returning({ id: platformGlobalCredentials.id });
      return deleted.length > 0;
    });
  };

  stageUpload = async (
    params: StagePlatformGlobalCredentialUploadParams,
  ): Promise<{ fileHashId: string; fileName: string }> => {
    assertPlatformGlobalCredentialFileSize(params.fileSize);
    this.assertEnvelope(params.envelope);

    const ref =
      params.envelope.ref ?? `kms://platform-global-credentials/upload/${params.fileHashId}`;

    return this.inTransaction(async (tx) => {
      // Opportunistic GC of expired staging rows (same transaction).
      await tx
        .delete(platformGlobalCredentialUploads)
        .where(lt(platformGlobalCredentialUploads.expiresAt, new Date()));

      await tx
        .insert(platformGlobalCredentialUploads)
        .values({
          ciphertext: params.envelope.ciphertext,
          createdBy: params.createdBy ?? null,
          expiresAt: params.expiresAt,
          fileHashId: params.fileHashId,
          fileName: params.fileName,
          fileSize: params.fileSize,
          fileType: params.fileType,
          fingerprint: params.envelope.fingerprint,
          keyId: params.envelope.keyId,
          ref,
        })
        .onConflictDoUpdate({
          set: {
            ciphertext: params.envelope.ciphertext,
            createdBy: params.createdBy ?? null,
            expiresAt: params.expiresAt,
            fileName: params.fileName,
            fileSize: params.fileSize,
            fileType: params.fileType,
            fingerprint: params.envelope.fingerprint,
            keyId: params.envelope.keyId,
            ref,
          },
          target: platformGlobalCredentialUploads.fileHashId,
        });

      return { fileHashId: params.fileHashId, fileName: params.fileName };
    });
  };

  /**
   * Create a file credential from a staged upload in one transaction.
   * On key conflict the TX rolls back and the staging row remains for retry.
   * Staging is deleted only after credential+secret insert succeeds.
   */
  createFromStagedUpload = async (params: {
    createdBy?: string | null;
    fileHashId: string;
    key: string;
    meta?: PlatformGlobalCredentialMeta;
    name: string;
  }): Promise<PlatformGlobalCredentialPublicView> => {
    this.assertKey(params.key);
    this.assertName(params.name);

    return this.inTransaction(async (tx) => {
      const [upload] = await tx
        .select()
        .from(platformGlobalCredentialUploads)
        .where(
          and(
            eq(platformGlobalCredentialUploads.fileHashId, params.fileHashId),
            gt(platformGlobalCredentialUploads.expiresAt, new Date()),
          ),
        )
        .for('update');
      if (!upload) {
        throw new PlatformGlobalCredentialValidationError(
          'Uploaded file not found or expired; please re-upload',
        );
      }

      const fileName = params.meta?.fileName ?? upload.fileName;
      const meta: PlatformGlobalCredentialMeta = {
        description: params.meta?.description,
        fileName,
        fileSize: upload.fileSize,
        maskedPreview: params.meta?.maskedPreview ?? fileName,
      };

      let inserted: PlatformGlobalCredentialItem;
      try {
        const [row] = await tx
          .insert(platformGlobalCredentials)
          .values({
            createdBy: params.createdBy ?? null,
            enabled: true,
            key: params.key,
            meta,
            name: params.name,
            type: 'file',
            updatedBy: params.createdBy ?? null,
          } satisfies NewPlatformGlobalCredential)
          .returning();
        if (!row) throw new PlatformGlobalCredentialValidationError('Failed to insert credential');
        inserted = row;
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new PlatformGlobalCredentialConflictError(
            `Credential key already exists: ${params.key}`,
          );
        }
        throw error;
      }

      const ref = `kms://platform-global-credentials/${inserted.id}/${randomUUID()}`;
      await tx.insert(platformGlobalCredentialSecrets).values({
        ciphertext: upload.ciphertext,
        credentialId: inserted.id,
        fingerprint: upload.fingerprint,
        keyId: upload.keyId,
        ref,
        revision: 1,
      });

      // Only remove staging after credential is durable.
      await tx
        .delete(platformGlobalCredentialUploads)
        .where(eq(platformGlobalCredentialUploads.fileHashId, params.fileHashId));

      return toPublicView(inserted);
    });
  };

  /**
   * Peek a staged upload without consuming it (tests / diagnostics).
   * Internal only.
   */
  getStagedUpload = async (
    fileHashId: string,
  ): Promise<PlatformGlobalCredentialUploadItem | null> => {
    const [row] = await this.db
      .select()
      .from(platformGlobalCredentialUploads)
      .where(
        and(
          eq(platformGlobalCredentialUploads.fileHashId, fileHashId),
          gt(platformGlobalCredentialUploads.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  /**
   * Consume a staged upload (delete + return envelope). Returns null if missing/expired.
   * Prefer {@link createFromStagedUpload} for createFile to avoid destroying staging on conflict.
   */
  consumeUpload = async (
    fileHashId: string,
  ): Promise<PlatformGlobalCredentialUploadItem | null> => {
    return this.inTransaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(platformGlobalCredentialUploads)
        .where(
          and(
            eq(platformGlobalCredentialUploads.fileHashId, fileHashId),
            gt(platformGlobalCredentialUploads.expiresAt, new Date()),
          ),
        )
        .for('update');
      if (!row) return null;
      await tx
        .delete(platformGlobalCredentialUploads)
        .where(eq(platformGlobalCredentialUploads.fileHashId, fileHashId));
      return row;
    });
  };

  /** Test/ops helper: count secret rows for a credential (never returns payload). */
  countSecrets = async (credentialId: number): Promise<number> => {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(platformGlobalCredentialSecrets)
      .where(eq(platformGlobalCredentialSecrets.credentialId, credentialId));
    return row?.count ?? 0;
  };

  private assertKey = (key: string) => {
    if (!key || key.length > 100 || !KEY_PATTERN.test(key)) {
      throw new PlatformGlobalCredentialValidationError(
        'Credential key must be 1–100 chars of [A-Za-z0-9_-]',
      );
    }
  };

  private assertName = (name: string) => {
    if (!name || name.length > 255) {
      throw new PlatformGlobalCredentialValidationError('Credential name must be 1–255 characters');
    }
  };

  private assertEnvelope = (envelope: PlatformGlobalCredentialEnvelope) => {
    if (!envelope.ciphertext || !envelope.keyId) {
      throw new PlatformGlobalCredentialValidationError('Secret envelope is incomplete');
    }
    if (!/^[a-f0-9]{64}$/.test(envelope.fingerprint)) {
      throw new PlatformGlobalCredentialValidationError('Secret fingerprint is invalid');
    }
  };

  private isUniqueViolation = (error: unknown): boolean => {
    const candidates: unknown[] = [error];
    if (error && typeof error === 'object') {
      const e = error as { cause?: unknown; originalError?: unknown };
      if (e.cause) candidates.push(e.cause);
      if (e.originalError) candidates.push(e.originalError);
      // drizzle-orm often nests: Error { cause: DatabaseError { code: '23505' } }
      if (e.cause && typeof e.cause === 'object' && 'cause' in e.cause) {
        candidates.push((e.cause as { cause?: unknown }).cause);
      }
    }
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const code = 'code' in candidate ? String((candidate as { code?: unknown }).code) : '';
      // Postgres unique_violation
      if (code === '23505') return true;
      const message =
        candidate instanceof Error
          ? candidate.message
          : 'message' in candidate
            ? String((candidate as { message?: unknown }).message)
            : '';
      if (/unique|duplicate|already exists/i.test(message)) return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return /unique|duplicate|already exists|platform_global_credentials_key_unique/i.test(message);
  };
}
