/**
 * Admin service for platform-owned global credentials.
 *
 * Encrypts via PlatformSecretService; public DTOs never include plaintext,
 * ciphertext, fingerprints, or refs.
 */
import { createHash, randomUUID } from 'node:crypto';

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
import type { LobeChatDatabase } from '@/database/type';

import type { PlatformSecretService } from '../../security/secret';
import { PlatformAuditService } from '../platformAudit';

const UPLOAD_TTL_MS = 60 * 60 * 1000;

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

const maskValue = (): string => '••••••••';

export class PlatformGlobalCredentialAdminService {
  private readonly model: PlatformGlobalCredentialModel;
  private readonly audit: PlatformAuditService;

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly secrets: PlatformSecretService,
  ) {
    this.model = new PlatformGlobalCredentialModel(db);
    this.audit = new PlatformAuditService(db);
  }

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
    const valueKeys = Object.keys(params.values).filter((k) => k && params.values[k] != null);
    if (valueKeys.length === 0) {
      throw new PlatformGlobalCredentialValidationError('At least one key-value pair is required');
    }
    const payload = JSON.stringify(params.values);
    const envelope = await this.encryptPayload(payload);

    const created = await this.model.create({
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

    await this.audit.append({
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
  };

  uploadFile = async (params: {
    actorUserId: string;
    fileBase64: string;
    fileName: string;
    fileType: string;
  }): Promise<{ fileHashId: string; fileName: string }> => {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(params.fileBase64, 'base64');
    } catch {
      throw new PlatformGlobalCredentialValidationError('Invalid base64 file payload');
    }
    if (bytes.byteLength === 0) {
      throw new PlatformGlobalCredentialValidationError('File is empty');
    }
    if (bytes.byteLength > PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES) {
      throw new PlatformGlobalCredentialFileTooLargeError();
    }

    const fileHashId = createHash('sha256').update(bytes).digest('hex');
    const envelope = await this.encryptBytes(bytes);

    const staged = await this.model.stageUpload({
      createdBy: params.actorUserId,
      envelope,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
      fileHashId,
      fileName: params.fileName,
      fileSize: bytes.byteLength,
      fileType: params.fileType,
    });

    await this.audit.append({
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
  };

  createFile = async (params: {
    actorUserId: string;
    description?: string;
    fileHashId: string;
    fileName: string;
    key: string;
    name: string;
  }): Promise<PlatformGlobalCredentialSummaryDto> => {
    const upload = await this.model.consumeUpload(params.fileHashId);
    if (!upload) {
      throw new PlatformGlobalCredentialValidationError(
        'Uploaded file not found or expired; please re-upload',
      );
    }

    const created = await this.model.create({
      createdBy: params.actorUserId,
      envelope: {
        ciphertext: upload.ciphertext,
        fingerprint: upload.fingerprint,
        keyId: upload.keyId,
        ref: `kms://platform-global-credentials/${randomUUID()}`,
      },
      key: params.key,
      meta: {
        description: params.description,
        fileName: params.fileName || upload.fileName,
        fileSize: upload.fileSize,
        maskedPreview: params.fileName || upload.fileName,
      },
      name: params.name,
      type: 'file',
    });

    await this.audit.append({
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
  };

  update = async (params: {
    actorUserId: string;
    description?: string;
    id: number;
    name?: string;
    values?: Record<string, string>;
  }): Promise<PlatformGlobalCredentialSummaryDto> => {
    const existing = await this.model.getById(params.id);
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

    if (params.values) {
      if (existing.type !== 'kv-env' && existing.type !== 'kv-header') {
        throw new PlatformGlobalCredentialValidationError(
          'Values can only be updated for KV credentials',
        );
      }
      const keys = Object.keys(params.values).filter((k) => k && params.values![k] != null);
      if (keys.length === 0) {
        throw new PlatformGlobalCredentialValidationError(
          'At least one key-value pair is required',
        );
      }
      envelope = await this.encryptPayload(JSON.stringify(params.values));
      valueKeys = keys;
      maskedPreview = 'configured';
    }

    const updated = await this.model.update({
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

    await this.audit.append({
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
  };

  delete = async (params: { actorUserId: string; id: number }): Promise<{ success: boolean }> => {
    const existing = await this.model.getById(params.id);
    if (!existing) throw new PlatformGlobalCredentialNotFoundError();

    const ok = await this.model.deleteById(params.id);
    await this.audit.append({
      action: 'admin.creds.delete',
      actorUserId: params.actorUserId,
      beforeDiff: { id: existing.id, key: existing.key, type: existing.type },
      reason: 'platform_global_credential_mutation',
      result: 'success',
      targetId: String(params.id),
      targetType: 'platform_global_credential',
    });
    return { success: ok };
  };

  deleteByKey = async (params: {
    actorUserId: string;
    key: string;
  }): Promise<{ success: boolean }> => {
    const existing = await this.model.getByKey(params.key);
    if (!existing) throw new PlatformGlobalCredentialNotFoundError();

    const ok = await this.model.deleteByKey(params.key);
    await this.audit.append({
      action: 'admin.creds.deleteByKey',
      actorUserId: params.actorUserId,
      beforeDiff: { id: existing.id, key: existing.key, type: existing.type },
      reason: 'platform_global_credential_mutation',
      result: 'success',
      targetId: String(existing.id),
      targetType: 'platform_global_credential',
    });
    return { success: ok };
  };

  /** Honest empty skill status — runtime inject is out of scope for this wave. */
  getSkillCredStatus = async (_skillIdentifier: string): Promise<unknown[]> => [];

  /** OAuth is disabled for platform global credentials. */
  listOAuthConnections = async (): Promise<{ connections: unknown[] }> => ({ connections: [] });

  createOAuth = async (): Promise<never> => {
    throw new PlatformGlobalCredentialOauthUnsupportedError();
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
