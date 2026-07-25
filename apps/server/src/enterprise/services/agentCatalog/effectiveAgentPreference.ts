/**
 * Owner-scoped visibility preference writes for platform Agents.
 * Separated from the effective-list resolver so authorization/list SQL and
 * mutation paths do not share one oversized module.
 */
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';

import {
  PlatformAgentInvalidInputError,
  PlatformAgentNotFoundError,
  redactPlatformReadError,
} from './errors';

export interface PlatformAgentHiddenWriteTarget {
  checksum: string;
  distribution: string;
  platformAgentId: string;
  versionId: string;
}

/**
 * Persist hide/unhide for an already-authorized target. Callers must resolve entitlement first.
 */
export const setPlatformAgentHiddenPreference = async (
  db: LobeChatDatabase,
  params: {
    hidden: boolean;
    target: PlatformAgentHiddenWriteTarget;
    userId: string;
  },
): Promise<void> => {
  try {
    const { target, userId, hidden } = params;
    // A mandatory Agent can never be hidden by an ordinary user (ROOT-01).
    if (hidden && target.distribution === 'mandatory') {
      throw new PlatformAgentInvalidInputError();
    }
    const written = await new PlatformAgentCatalogRepository(db).setMaterializationHidden({
      hidden,
      platformAgentId: target.platformAgentId,
      platformAgentVersionChecksum: target.checksum,
      platformAgentVersionId: target.versionId,
      userId,
    });
    if (!written) throw new PlatformAgentNotFoundError();
  } catch (error) {
    throw redactPlatformReadError(error);
  }
};
