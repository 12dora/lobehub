/**
 * Platform-global credentials — no ownership / workspace scope.
 *
 * Public projections never include ciphertext, fingerprint, ref, or plaintext.
 * Envelope material is only returned via internal secret accessors for server
 * services that decrypt in-process.
 */
import { randomUUID } from 'node:crypto';

import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import {
  type NewPlatformGlobalCredential,
  type PlatformGlobalCredentialItem,
  type PlatformGlobalCredentialMeta,
  platformGlobalCredentials,
  type PlatformGlobalCredentialSecretItem,
  platformGlobalCredentialSecrets,
  type PlatformGlobalCredentialUploadItem,
  platformGlobalCredentialUploads,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import {
  PlatformGlobalCredentialConflictError,
  PlatformGlobalCredentialNotFoundError,
  PlatformGlobalCredentialValidationError,
  PlatformRevisionConflictError,
} from './globalCredential.errors';
import { assertPlatformGlobalCredentialFileSize, toPublicView } from './globalCredential.helpers';
import type {
  CreatePlatformGlobalCredentialParams,
  PlatformGlobalCredentialPublicView,
  StagePlatformGlobalCredentialUploadParams,
  UpdatePlatformGlobalCredentialParams,
} from './globalCredential.types';
import {
  assertActor,
  assertEnvelope,
  assertFileHashId,
  assertKey,
  assertName,
} from './globalCredential.validators';
import { isUniqueViolation } from './pgUniqueViolation';

export {
  PlatformGlobalCredentialConflictError,
  PlatformGlobalCredentialFileTooLargeError,
  PlatformGlobalCredentialNotFoundError,
  PlatformGlobalCredentialValidationError,
  PlatformRevisionConflictError,
} from './globalCredential.errors';
export {
  assertPlatformGlobalCredentialFileSize,
  fingerprintPayload,
  repairPlatformGlobalCredentialIdSequence,
} from './globalCredential.helpers';
export type {
  CreatePlatformGlobalCredentialParams,
  PlatformGlobalCredentialEnvelope,
  PlatformGlobalCredentialPublicView,
  StagePlatformGlobalCredentialUploadParams,
  UpdatePlatformGlobalCredentialParams,
} from './globalCredential.types';

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

  /**
   * Row-lock the credential for a secret merge / CAS update.
   * Must be called inside an open transaction so the lock is held across
   * decrypt → merge → encrypt → write.
   */
  getByIdForUpdate = async (
    id: number,
  ): Promise<PlatformGlobalCredentialPublicView | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformGlobalCredentials)
      .where(eq(platformGlobalCredentials.id, id))
      .for('update')
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
    assertKey(params.key);
    assertName(params.name);
    assertEnvelope(params.envelope);
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
        if (isUniqueViolation(error)) {
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
    if (params.name !== undefined) assertName(params.name);
    if (params.envelope) assertEnvelope(params.envelope);
    if (params.meta?.fileSize !== undefined) {
      assertPlatformGlobalCredentialFileSize(params.meta.fileSize);
    }
    if (!Number.isInteger(params.expectedRevision) || params.expectedRevision < 0) {
      throw new PlatformGlobalCredentialValidationError(
        'expectedRevision must be a non-negative integer',
      );
    }

    return this.inTransaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(platformGlobalCredentials)
        .where(eq(platformGlobalCredentials.id, params.id))
        .for('update');
      if (!existing) throw new PlatformGlobalCredentialNotFoundError();
      if (existing.revision !== params.expectedRevision) {
        throw new PlatformRevisionConflictError(
          'Credential revision conflict: expectedRevision does not match current revision',
          {
            currentRevision: existing.revision,
            expectedRevision: params.expectedRevision,
            resourceId: String(params.id),
            resourceType: 'platform_global_credential',
          },
        );
      }

      const nextMeta: PlatformGlobalCredentialMeta = {
        ...existing.meta,
        ...params.meta,
      };
      const nextRevision = existing.revision + 1;

      const [updated] = await tx
        .update(platformGlobalCredentials)
        .set({
          meta: nextMeta,
          name: params.name ?? existing.name,
          revision: nextRevision,
          updatedBy: params.updatedBy ?? existing.updatedBy,
        })
        .where(
          and(
            eq(platformGlobalCredentials.id, params.id),
            eq(platformGlobalCredentials.revision, params.expectedRevision),
          ),
        )
        .returning();
      if (!updated) {
        // Lost the CAS race after the lock was released (should be rare under FOR UPDATE).
        throw new PlatformRevisionConflictError(
          'Credential revision conflict: expectedRevision does not match current revision',
          {
            expectedRevision: params.expectedRevision,
            resourceId: String(params.id),
            resourceType: 'platform_global_credential',
          },
        );
      }

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

  /**
   * Rotate a file credential from an owner-bound staged upload under the same
   * row lock + optimistic CAS as {@link update}. Consumes the staging row only
   * after the new secret revision is inserted.
   *
   * Optional `testHooks` are production-no-ops used by concurrency / rollback
   * regressions (barrier after lock, force-fail after mutations).
   */
  updateFromStagedUpload = async (params: {
    createdBy: string;
    expectedRevision: number;
    fileHashId: string;
    id: number;
    meta?: PlatformGlobalCredentialMeta;
    name?: string;
    /**
     * Test-only seams. Never set from production call sites.
     * - `afterCredentialLock`: after FOR UPDATE + revision CAS check, before writes.
     * - `afterMutations`: after credential/secret/staging writes, before commit.
     */
    testHooks?: {
      afterCredentialLock?: () => Promise<void> | void;
      afterMutations?: () => Promise<void> | void;
    };
  }): Promise<PlatformGlobalCredentialPublicView> => {
    assertActor(params.createdBy);
    assertFileHashId(params.fileHashId);
    if (params.name !== undefined) assertName(params.name);
    if (!Number.isInteger(params.expectedRevision) || params.expectedRevision < 0) {
      throw new PlatformGlobalCredentialValidationError(
        'expectedRevision must be a non-negative integer',
      );
    }

    return this.inTransaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(platformGlobalCredentials)
        .where(eq(platformGlobalCredentials.id, params.id))
        .for('update');
      if (!existing) throw new PlatformGlobalCredentialNotFoundError();
      if (existing.type !== 'file') {
        throw new PlatformGlobalCredentialValidationError(
          'Staged file uploads can only rotate file credentials',
        );
      }
      if (existing.revision !== params.expectedRevision) {
        throw new PlatformRevisionConflictError(
          'Credential revision conflict: expectedRevision does not match current revision',
          {
            currentRevision: existing.revision,
            expectedRevision: params.expectedRevision,
            resourceId: String(params.id),
            resourceType: 'platform_global_credential',
          },
        );
      }

      // Deterministic concurrency barrier: first writer holds the row lock here
      // while the second issues its FOR UPDATE (observe via pg_blocking_pids +
      // ungranted transactionid wait on this backend's xid — not a granted tuple lock).
      await params.testHooks?.afterCredentialLock?.();

      const [upload] = await tx
        .select()
        .from(platformGlobalCredentialUploads)
        .where(
          and(
            eq(platformGlobalCredentialUploads.fileHashId, params.fileHashId),
            eq(platformGlobalCredentialUploads.createdBy, params.createdBy),
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
      const nextMeta: PlatformGlobalCredentialMeta = {
        ...existing.meta,
        ...params.meta,
        fileName,
        fileSize: upload.fileSize,
        maskedPreview: params.meta?.maskedPreview ?? fileName,
      };
      const nextRevision = existing.revision + 1;

      const [updated] = await tx
        .update(platformGlobalCredentials)
        .set({
          meta: nextMeta,
          name: params.name ?? existing.name,
          revision: nextRevision,
          updatedBy: params.createdBy,
        })
        .where(
          and(
            eq(platformGlobalCredentials.id, params.id),
            eq(platformGlobalCredentials.revision, params.expectedRevision),
          ),
        )
        .returning();
      if (!updated) {
        throw new PlatformRevisionConflictError(
          'Credential revision conflict: expectedRevision does not match current revision',
          {
            expectedRevision: params.expectedRevision,
            resourceId: String(params.id),
            resourceType: 'platform_global_credential',
          },
        );
      }

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

      const ref = `kms://platform-global-credentials/${params.id}/${randomUUID()}`;
      await tx.insert(platformGlobalCredentialSecrets).values({
        ciphertext: upload.ciphertext,
        credentialId: params.id,
        fingerprint: upload.fingerprint,
        keyId: upload.keyId,
        ref,
        revision: (prev?.revision ?? 0) + 1,
      });

      await tx
        .delete(platformGlobalCredentialUploads)
        .where(
          and(
            eq(platformGlobalCredentialUploads.id, upload.id),
            eq(platformGlobalCredentialUploads.createdBy, params.createdBy),
          ),
        );

      // Force mid-rotation abort after real writes so TX rollback is exercised.
      await params.testHooks?.afterMutations?.();

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
    assertEnvelope(params.envelope);
    assertActor(params.createdBy);
    assertFileHashId(params.fileHashId);

    const ref =
      params.envelope.ref ?? `kms://platform-global-credentials/upload/${params.fileHashId}`;

    return this.inTransaction(async (tx) => {
      // Opportunistic GC of expired staging rows (same transaction).
      await tx
        .delete(platformGlobalCredentialUploads)
        .where(lt(platformGlobalCredentialUploads.expiresAt, new Date()));

      // Owner-scoped upsert only — never overwrite another administrator's staging row.
      await tx
        .insert(platformGlobalCredentialUploads)
        .values({
          ciphertext: params.envelope.ciphertext,
          createdBy: params.createdBy,
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
            expiresAt: params.expiresAt,
            fileName: params.fileName,
            fileSize: params.fileSize,
            fileType: params.fileType,
            fingerprint: params.envelope.fingerprint,
            keyId: params.envelope.keyId,
            ref,
          },
          target: [
            platformGlobalCredentialUploads.createdBy,
            platformGlobalCredentialUploads.fileHashId,
          ],
        });

      return { fileHashId: params.fileHashId, fileName: params.fileName };
    });
  };

  /**
   * Create a file credential from a staged upload in one transaction.
   * On key conflict the TX rolls back and the staging row remains for retry.
   * Staging is deleted only after credential+secret insert succeeds.
   * Requires `createdBy` to match the owning administrator of the staged row.
   */
  createFromStagedUpload = async (params: {
    createdBy: string;
    fileHashId: string;
    key: string;
    meta?: PlatformGlobalCredentialMeta;
    name: string;
  }): Promise<PlatformGlobalCredentialPublicView> => {
    assertKey(params.key);
    assertName(params.name);
    assertActor(params.createdBy);
    assertFileHashId(params.fileHashId);

    return this.inTransaction(async (tx) => {
      const [upload] = await tx
        .select()
        .from(platformGlobalCredentialUploads)
        .where(
          and(
            eq(platformGlobalCredentialUploads.fileHashId, params.fileHashId),
            eq(platformGlobalCredentialUploads.createdBy, params.createdBy),
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
            createdBy: params.createdBy,
            enabled: true,
            key: params.key,
            meta,
            name: params.name,
            type: 'file',
            updatedBy: params.createdBy,
          } satisfies NewPlatformGlobalCredential)
          .returning();
        if (!row) throw new PlatformGlobalCredentialValidationError('Failed to insert credential');
        inserted = row;
      } catch (error) {
        if (isUniqueViolation(error)) {
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

      // Only remove the owner's staging row after credential is durable.
      await tx
        .delete(platformGlobalCredentialUploads)
        .where(
          and(
            eq(platformGlobalCredentialUploads.id, upload.id),
            eq(platformGlobalCredentialUploads.createdBy, params.createdBy),
          ),
        );

      return toPublicView(inserted);
    });
  };

  /**
   * Peek a staged upload without consuming it (tests / diagnostics).
   * Always scoped to the owning administrator.
   */
  getStagedUpload = async (
    fileHashId: string,
    createdBy: string,
  ): Promise<PlatformGlobalCredentialUploadItem | null> => {
    assertActor(createdBy);
    assertFileHashId(fileHashId);
    const [row] = await this.db
      .select()
      .from(platformGlobalCredentialUploads)
      .where(
        and(
          eq(platformGlobalCredentialUploads.fileHashId, fileHashId),
          eq(platformGlobalCredentialUploads.createdBy, createdBy),
          gt(platformGlobalCredentialUploads.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  /**
   * Consume a staged upload (delete + return envelope). Returns null if missing/expired/wrong owner.
   * Prefer {@link createFromStagedUpload} for createFile to avoid destroying staging on conflict.
   */
  consumeUpload = async (
    fileHashId: string,
    createdBy: string,
  ): Promise<PlatformGlobalCredentialUploadItem | null> => {
    assertActor(createdBy);
    assertFileHashId(fileHashId);
    return this.inTransaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(platformGlobalCredentialUploads)
        .where(
          and(
            eq(platformGlobalCredentialUploads.fileHashId, fileHashId),
            eq(platformGlobalCredentialUploads.createdBy, createdBy),
            gt(platformGlobalCredentialUploads.expiresAt, new Date()),
          ),
        )
        .for('update');
      if (!row) return null;
      await tx
        .delete(platformGlobalCredentialUploads)
        .where(
          and(
            eq(platformGlobalCredentialUploads.id, row.id),
            eq(platformGlobalCredentialUploads.createdBy, createdBy),
          ),
        );
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
}
