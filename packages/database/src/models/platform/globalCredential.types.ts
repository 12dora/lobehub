import type {
  PlatformGlobalCredentialMeta,
  PlatformGlobalCredentialType,
} from '../../schemas/platform';

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
  /** Optimistic CAS generation; clients must echo this on update. */
  revision: number;
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
  /**
   * Required optimistic CAS token. Must equal the locked row's revision or the
   * update is rejected with {@link PlatformRevisionConflictError}.
   */
  expectedRevision: number;
  id: number;
  meta?: PlatformGlobalCredentialMeta;
  name?: string;
  updatedBy?: string | null;
}

export interface StagePlatformGlobalCredentialUploadParams {
  /** Required owning administrator — staging rows are never anonymous. */
  createdBy: string;
  envelope: PlatformGlobalCredentialEnvelope;
  expiresAt: Date;
  /** SHA-256 of plaintext content (metadata only; not the sole ownership key). */
  fileHashId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
}
