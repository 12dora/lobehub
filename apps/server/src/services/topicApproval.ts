import type { LobeChatDatabase } from '@lobechat/database';
import type { ChatTopicMetadata } from '@lobechat/types';

import { resolvePersonalTopicApprovalSnapshot } from '@/server/enterprise/services/settings/runtimeSettingsAdapter';

export type { PersonalTopicApprovalResolution } from '@/server/enterprise/services/settings/runtimeSettingsAdapter';
export { resolvePersonalTopicApprovalSnapshot } from '@/server/enterprise/services/settings/runtimeSettingsAdapter';

/**
 * Drop `approvalMode` from a metadata patch. Used by workspace sanitization
 * (never persist) and by personal create (always re-resolve, never trust the
 * client field as-is).
 */
export const omitTopicApprovalMode = (
  metadata?: ChatTopicMetadata,
): ChatTopicMetadata | undefined => {
  if (!metadata) return undefined;
  const { approvalMode: _omitted, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? (rest as ChatTopicMetadata) : undefined;
};

/**
 * Workspace topics never persist `approvalMode`. Strips it from an incoming
 * metadata patch when `workspaceId` is present; personal topics pass through
 * unchanged (including a client-supplied `approvalMode`).
 */
export const sanitizeWorkspaceTopicMetadata = (
  metadata: ChatTopicMetadata | undefined,
  workspaceId?: string | null,
): ChatTopicMetadata | undefined => {
  if (!workspaceId) return metadata;
  return omitTopicApprovalMode(metadata);
};

/**
 * Merge a personal-topic approval snapshot into topic metadata.
 *
 * Always strips a client-supplied `approvalMode` first. Workspace topics keep
 * the rest of the metadata and never snapshot. Personal topics add the
 * resolver `snapshotMode` only when it is a persistable (non-headless) mode.
 */
export const applyTopicApprovalSnapshot = async (params: {
  db: LobeChatDatabase;
  metadata?: ChatTopicMetadata;
  userId: string;
  workspaceId?: string | null;
}): Promise<ChatTopicMetadata | undefined> => {
  const restMeta = omitTopicApprovalMode(params.metadata);

  if (params.workspaceId) return restMeta;

  const { snapshotMode } = await resolvePersonalTopicApprovalSnapshot({
    clientApprovalMode: params.metadata?.approvalMode,
    db: params.db,
    userId: params.userId,
  });

  if (!snapshotMode) return restMeta;
  return { ...restMeta, approvalMode: snapshotMode };
};
