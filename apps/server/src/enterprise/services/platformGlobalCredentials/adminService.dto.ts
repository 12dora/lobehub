import type { PlatformGlobalCredentialPublicView } from '@/database/models/platform';
import type { PlatformGlobalCredentialType } from '@/database/schemas/platform';

import { PLATFORM_GLOBAL_CREDENTIAL_MASK } from '../../contracts/adminCreds';

export type PlatformGlobalCredentialPublicMaskValue =
  typeof PLATFORM_GLOBAL_CREDENTIAL_MASK | 'configured' | 'not_configured';

export interface PlatformGlobalCredentialSummaryDto {
  createdAt: string;
  description?: string;
  fileName?: string;
  fileSize?: number;
  id: number;
  key: string;
  maskedPreview?: string;
  name: string;
  /** Optimistic CAS generation; required on subsequent updates. */
  revision: number;
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
  plaintext?: Record<string, PlatformGlobalCredentialPublicMaskValue>;
}

export const toIso = (d: Date) => d.toISOString();

export const toSummary = (
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
  revision: row.revision,
  type: row.type,
  updatedAt: toIso(row.updatedAt),
});

export const maskValue = (): typeof PLATFORM_GLOBAL_CREDENTIAL_MASK =>
  PLATFORM_GLOBAL_CREDENTIAL_MASK;
