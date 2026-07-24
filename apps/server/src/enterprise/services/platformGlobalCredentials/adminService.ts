/**
 * Admin service for platform-owned global credentials.
 *
 * Encrypts via PlatformSecretService; public DTOs never include plaintext,
 * ciphertext, fingerprints, or refs.
 */
import { createHash } from 'node:crypto';

import {
  fingerprintPayload,
  PlatformGlobalCredentialConflictError,
  PlatformGlobalCredentialFileTooLargeError,
  PlatformGlobalCredentialModel,
  PlatformGlobalCredentialNotFoundError,
  type PlatformGlobalCredentialPublicView,
  PlatformGlobalCredentialValidationError,
} from '@/database/models/platform';
import {
  PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES,
  type PlatformGlobalCredentialType,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { PlatformSecretService } from '../../security/secret';
import { PlatformAuditService } from '../platformAudit';

const UPLOAD_TTL_MS = 60 * 60 * 1000;

/** Canonical base64 only — Node's Buffer decoder is lenient with invalid chars. */
const isCanonicalBase64 = (value: string, bytes: Buffer): boolean => {
  if (!/^(?:[A-Z\d+/]{4})*(?:[A-Z\d+/]{2}==|[A-Z\d+/]{3}=)?$/i.test(value)) {
    return false;
  }
  return bytes.toString('base64') === value;
};

/** Fixed mask returned by get(decrypt) — never accept as a real secret value. */
export const PLATFORM_GLOBAL_CREDENTIAL_MASK = '••••••••';

export class PlatformGlobalCredentialOauthUnsupportedError extends Error {
  readonly code = 'PLATFORM_GLOBAL_CREDENTIAL_OAUTH_UNSUPPORTED';
  constructor(message = 'Platform global credentials do not support OAuth type') {
    super(message);
    this.name = 'PlatformGlobalCredentialOauthUnsupportedError';
  }
}

export interface PlatformGlobalCredentialSummaryDto {
  createdAt: string;
  description?: string;
  fileName?: string;
  fileSize?: number;
  id: number;
  key: string;
  maskedPreview?: string;
  name: string;
  type: PlatformGlobalCredentialType;
  updatedAt: string;
}

/** Get response: metadata + configured flag; plaintext keys map to masks only when decrypt requested. */
export interface PlatformGlobalCredentialGetDto extends PlatformGlobalCredentialSummaryDto {
  /** Always true when a secret envelope exists; never reveals material. */
  configured: boolean;
  /**
   * When decrypt=true: public key names → fixed mask (M13: no plaintext echo).
   * When decrypt=false/undefined: omitted.
   */
  plaintext?: Record<string, string>;
}

const toIso = (d: Date) => d.toISOString();

const toSummary = (
  row: PlatformGlobalCredentialPublicView,
): PlatformGlobalCredentialSummaryDto => ({
  createdAt: toIso(row.createdAt),
  description: row.description,
  fileName: row.fileName,
  fileSize: row.fileSize,
  id: row.id,
  key: row.key,
  maskedPreview: row.maskedPreview ?? (row.type === 'file' ? row.fileName : 'configured'),
  name: row.name,
  type: row.type,
  updatedAt: toIso(row.updatedAt),
});

const maskValue = (): string => PLATFORM_GLOBAL_CREDENTIAL_MASK;

/** Reject any field whose value is the public mask string (prevents silent secret destruction). */
export const assertNoMaskedSecretValues = (values: Record<string, string>): void => {
  for (const [key, value] of Object.entries(values)) {
    if (value === PLATFORM_GLOBAL_CREDENTIAL_MASK) {
      throw new PlatformGlobalCredentialValidationError(
        `Refusing to store masked placeholder for key "${key}". Leave the field empty to keep the existing value, or enter a new secret.`,
      );
    }
  }
};

/** Drop empty values; empty object means "no secret rotation". */
export const filterNonEmptySecretValues = (
  values: Record<string, string>,
): Record<string, string> => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key || value == null || value === '') continue;
    next[key] = value;
  }
  return next;
};

export interface PlatformGlobalCredentialAdminServiceOptions {
  /**
   * Test/fault seams. Production callers leave this undefined.
   * `afterLockBeforeSecretMerge` runs after FOR UPDATE + current secret read,
   * before encrypt/write — used to force concurrent interleaving in tests.
   * `createAudit` substitutes the transaction-scoped audit service (rollback tests).
   */
  createAudit?: (db: LobeChatDatabase | Transaction) => PlatformAuditService;
  lifecycle?: {
    afterLockBeforeSecretMerge?: (params: { id: number }) => Promise<void>;
  };
}

export class PlatformGlobalCredentialAdminService {
  private readonly model: PlatformGlobalCredentialModel;
  private readonly createAudit: (db: LobeChatDatabase | Transaction) => PlatformAuditService;
  private readonly lifecycle: PlatformGlobalCredentialAdminServiceOptions['lifecycle'];

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly secrets: PlatformSecretService,
    options: PlatformGlobalCredentialAdminServiceOptions = {},
  ) {
    this.model = new PlatformGlobalCredentialModel(db);
    this.createAudit = options.createAudit ?? ((conn) => new PlatformAuditService(conn));
    this.lifecycle = options.lifecycle;
  }

  /** Bind model + audit to a single transaction so mutation and success audit commit atomically. */
  private withTxn = async <T>(
    callback: (ctx: {
      audit: PlatformAuditService;
      model: PlatformGlobalCredentialModel;
      tx: Transaction;
    }) => Promise<T>,
  ): Promise<T> =>
    this.db.transaction(async (tx) =>
      callback({
        audit: this.createAudit(tx),
        model: new PlatformGlobalCredentialModel(tx),
        tx,
      }),
    );

  list = async (): Promise<{ data: PlatformGlobalCredentialSummaryDto[] }> => {
    const rows = await this.model.list();
    return { data: rows.map(toSummary) };
  };

  get = async (params: {
    decrypt?: boolean;
    id: number;
  }): Promise<PlatformGlobalCredentialGetDto> => {
    const row = await this.model.getById(params.id);
    if (!row) throw new PlatformGlobalCredentialNotFoundError();
    return this.toGetDto(row, params.decrypt === true);
  };

  getByKey = async (params: {
    decrypt?: boolean;
    key: string;
  }): Promise<PlatformGlobalCredentialGetDto> => {
    const row = await this.model.getByKey(params.key);
    if (!row)
      throw new PlatformGlobalCredentialNotFoundError(`Credential not found: ${params.key}`);
    return this.toGetDto(row, params.decrypt === true);
  };

  createKV = async (params: {
    actorUserId: string;
    description?: string;
    key: string;
    name: string;
    type: 'kv-env' | 'kv-header';
    values: Record<string, string>;
  }): Promise<PlatformGlobalCredentialSummaryDto> => {
    assertNoMaskedSecretValues(params.values);
    const valueMap = filterNonEmptySecretValues(params.values);
    const valueKeys = Object.keys(valueMap);
    if (valueKeys.length === 0) {
      throw new PlatformGlobalCredentialValidationError('At least one key-value pair is required');
    }
    const payload = JSON.stringify(valueMap);
    const envelope = await this.encryptPayload(payload);

    return this.withTxn(async ({ audit, model }) => {
      const created = await model.create({
        createdBy: params.actorUserId,
        envelope,
        key: params.key,
        meta: {
          description: params.description,
          maskedPreview: 'configured',
          valueKeys,
        },
        name: params.name,
        type: params.type,
      });

      await audit.append({
        action: 'admin.creds.createKV',
        actorUserId: params.actorUserId,
        afterDiff: {
          id: created.id,
          key: created.key,
          type: created.type,
          valueKeyCount: valueKeys.length,
        },
        reason: 'platform_global_credential_mutation',
        result: 'success',
        targetId: String(created.id),
        targetType: 'platform_global_credential',
      });

      return toSummary(created);
    });
  };

  uploadFile = async (params: {
    actorUserId: string;
    fileBase64: string;
    fileName: string;
    fileType: string;
  }): Promise<{ fileHashId: string; fileName: string }> => {
    const bytes = Buffer.from(params.fileBase64, 'base64');
    if (!isCanonicalBase64(params.fileBase64, bytes) || bytes.byteLength === 0) {
      throw new PlatformGlobalCredentialValidationError('Invalid base64 file payload');
    }
    if (bytes.byteLength > PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES) {
      throw new PlatformGlobalCredentialFileTooLargeError();
    }

    const fileHashId = createHash('sha256').update(bytes).digest('hex');
    const envelope = await this.encryptBytes(bytes);

    return this.withTxn(async ({ audit, model }) => {
      const staged = await model.stageUpload({
        createdBy: params.actorUserId,
        envelope,
        expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
        fileHashId,
        fileName: params.fileName,
        fileSize: bytes.byteLength,
        fileType: params.fileType,
      });

      await audit.append({
        action: 'admin.creds.uploadFile',
        actorUserId: params.actorUserId,
        afterDiff: {
          fileHashId: staged.fileHashId,
          fileName: staged.fileName,
          fileSize: bytes.byteLength,
        },
        reason: 'platform_global_credential_mutation',
        result: 'success',
        targetId: staged.fileHashId,
        targetType: 'platform_global_credential_upload',
      });

      return staged;
    });
  };

  createFile = async (params: {
    actorUserId: string;
    description?: string;
    fileHashId: string;
    fileName: string;
    key: string;
    name: string;
  }): Promise<PlatformGlobalCredentialSummaryDto> =>
    // Single TX: key conflict rolls back staging consume + keeps audit atomic.
    this.withTxn(async ({ audit, model }) => {
      const created = await model.createFromStagedUpload({
        createdBy: params.actorUserId,
        fileHashId: params.fileHashId,
        key: params.key,
        meta: {
          description: params.description,
          fileName: params.fileName,
        },
        name: params.name,
      });

      await audit.append({
        action: 'admin.creds.createFile',
        actorUserId: params.actorUserId,
        afterDiff: {
          fileName: created.fileName,
          fileSize: created.fileSize,
          id: created.id,
          key: created.key,
          type: 'file',
        },
        reason: 'platform_global_credential_mutation',
        result: 'success',
        targetId: String(created.id),
        targetType: 'platform_global_credential',
      });

      return toSummary(created);
    });

  update = async (params: {
    actorUserId: string;
    description?: string;
    id: number;
    name?: string;
    values?: Record<string, string>;
  }): Promise<PlatformGlobalCredentialSummaryDto> => {
    // Validate type/mask outside the lock when possible; secret merge must run
    // under FOR UPDATE so concurrent partial updates cannot lose disjoint keys.
    if (params.values !== undefined) {
      assertNoMaskedSecretValues(params.values);
    }

    return this.withTxn(async ({ audit, model }) => {
      // Lock first so concurrent partial secret updates serialize before merge.
      const existing = await model.getByIdForUpdate(params.id);
      if (!existing) throw new PlatformGlobalCredentialNotFoundError();

      let envelope:
        | {
            ciphertext: string;
            fingerprint: string;
            keyId: string;
          }
        | undefined;
      let valueKeys = existing.valueKeys;
      let maskedPreview = existing.maskedPreview;

      // values missing / empty after filter → metadata-only (do not touch secret).
      if (params.values !== undefined) {
        if (existing.type !== 'kv-env' && existing.type !== 'kv-header') {
          throw new PlatformGlobalCredentialValidationError(
            'Values can only be updated for KV credentials',
          );
        }
        const submitted = filterNonEmptySecretValues(params.values);

        if (Object.keys(submitted).length > 0) {
          // Decrypt/merge/encrypt while holding FOR UPDATE — disjoint concurrent
          // key additions both succeed without silent loss.
          const current = await this.readCurrentKvMap(existing.id, model);
          await this.lifecycle?.afterLockBeforeSecretMerge?.({ id: existing.id });
          const merged = { ...current, ...submitted };
          envelope = await this.encryptPayload(JSON.stringify(merged));
          valueKeys = Object.keys(merged);
          maskedPreview = 'configured';
        }
      }

      const updated = await model.update({
        envelope,
        id: params.id,
        meta: {
          description: params.description !== undefined ? params.description : existing.description,
          maskedPreview,
          valueKeys,
        },
        name: params.name,
        updatedBy: params.actorUserId,
      });

      await audit.append({
        action: 'admin.creds.update',
        actorUserId: params.actorUserId,
        afterDiff: {
          id: updated.id,
          name: updated.name,
          rotatedSecret: Boolean(envelope),
          valueKeyCount: valueKeys?.length,
        },
        beforeDiff: { id: existing.id, name: existing.name },
        reason: 'platform_global_credential_mutation',
        result: 'success',
        targetId: String(updated.id),
        targetType: 'platform_global_credential',
      });

      return toSummary(updated);
    });
  };

  delete = async (params: { actorUserId: string; id: number }): Promise<{ success: boolean }> =>
    this.withTxn(async ({ audit, model }) => {
      const existing = await model.getById(params.id);
      if (!existing) throw new PlatformGlobalCredentialNotFoundError();

      const ok = await model.deleteById(params.id);
      await audit.append({
        action: 'admin.creds.delete',
        actorUserId: params.actorUserId,
        beforeDiff: { id: existing.id, key: existing.key, type: existing.type },
        reason: 'platform_global_credential_mutation',
        result: 'success',
        targetId: String(params.id),
        targetType: 'platform_global_credential',
      });
      return { success: ok };
    });

  deleteByKey = async (params: {
    actorUserId: string;
    key: string;
  }): Promise<{ success: boolean }> =>
    this.withTxn(async ({ audit, model }) => {
      const existing = await model.getByKey(params.key);
      if (!existing) throw new PlatformGlobalCredentialNotFoundError();

      const ok = await model.deleteByKey(params.key);
      await audit.append({
        action: 'admin.creds.deleteByKey',
        actorUserId: params.actorUserId,
        beforeDiff: { id: existing.id, key: existing.key, type: existing.type },
        reason: 'platform_global_credential_mutation',
        result: 'success',
        targetId: String(existing.id),
        targetType: 'platform_global_credential',
      });
      return { success: ok };
    });

  /** Honest empty skill status — runtime inject is out of scope for this wave. */
  getSkillCredStatus = async (_skillIdentifier: string): Promise<unknown[]> => [];

  /** OAuth is disabled for platform global credentials. */
  listOAuthConnections = async (): Promise<{ connections: unknown[] }> => ({ connections: [] });

  createOAuth = async (): Promise<never> => {
    throw new PlatformGlobalCredentialOauthUnsupportedError();
  };

  private readCurrentKvMap = async (
    credentialId: number,
    model: PlatformGlobalCredentialModel = this.model,
  ): Promise<Record<string, string>> => {
    const active = await model.getActiveSecretEnvelope(credentialId);
    if (!active) return {};
    try {
      const plain = await this.secrets.decrypt(active.ciphertext);
      const parsed = JSON.parse(plain) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    } catch {
      throw new PlatformGlobalCredentialValidationError(
        'Unable to merge secret values: existing envelope is not readable',
      );
    }
  };

  private toGetDto = async (
    row: PlatformGlobalCredentialPublicView,
    decrypt: boolean,
  ): Promise<PlatformGlobalCredentialGetDto> => {
    const envelope = await this.model.getActiveSecretEnvelope(row.id);
    const base: PlatformGlobalCredentialGetDto = {
      ...toSummary(row),
      configured: Boolean(envelope),
    };

    if (!decrypt) return base;

    // M13: never return real plaintext. Surface key names + fixed masks / configured state.
    if (row.type === 'file') {
      return {
        ...base,
        plaintext: envelope
          ? { file: maskValue(), status: 'configured' }
          : { status: 'not_configured' },
      };
    }

    const keys = row.valueKeys ?? [];
    const plaintext: Record<string, string> = {};
    for (const k of keys) {
      plaintext[k] = maskValue();
    }
    if (keys.length === 0 && envelope) {
      plaintext['(configured)'] = maskValue();
    }
    return { ...base, plaintext };
  };

  private encryptPayload = async (payload: string) => {
    const ciphertext = await this.secrets.encrypt(payload);
    return {
      ciphertext,
      fingerprint: fingerprintPayload(payload),
      keyId: this.secrets.peekKeyId(ciphertext),
    };
  };

  private encryptBytes = async (bytes: Buffer) => {
    const ciphertext = await this.secrets.encrypt(bytes);
    return {
      ciphertext,
      fingerprint: fingerprintPayload(bytes),
      keyId: this.secrets.peekKeyId(ciphertext),
    };
  };
}

export {
  PlatformGlobalCredentialConflictError,
  PlatformGlobalCredentialFileTooLargeError,
  PlatformGlobalCredentialNotFoundError,
  PlatformGlobalCredentialValidationError,
};
