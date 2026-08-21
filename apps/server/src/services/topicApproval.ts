import type { LobeChatDatabase } from '@lobechat/database';
import type { ChatTopicMetadata, TopicApprovalMode } from '@lobechat/types';

import { resolvePersonalTopicApprovalSnapshot } from '@/server/enterprise/services/settings/runtimeSettingsAdapter';

export { resolvePersonalTopicApprovalSnapshot } from '@/server/enterprise/services/settings/runtimeSettingsAdapter';

/**
 * Merge a personal-topic approval snapshot into topic metadata.
 *
 * Always strips a client-supplied `approvalMode` first. Workspace topics keep
 * the rest of the metadata and never snapshot. Personal topics add the
 * resolver result only when it is a persistable (non-headless) mode.
 */
export const applyTopicApprovalSnapshot = async (params: {
  db: LobeChatDatabase;
  metadata?: ChatTopicMetadata;
  userId: string;
  workspaceId?: string | null;
}): Promise<ChatTopicMetadata | undefined> => {
  const { approvalMode: clientApprovalMode, ...rest } = params.metadata ?? {};
  const restMeta = Object.keys(rest).length > 0 ? (rest as ChatTopicMetadata) : undefined;

  if (params.workspaceId) return restMeta;

  const approvalMode = await resolvePersonalTopicApprovalSnapshot({
    clientApprovalMode: clientApprovalMode as TopicApprovalMode | undefined,
    db: params.db,
    userId: params.userId,
  });

  if (!approvalMode) return restMeta;
  return { ...rest, approvalMode };
};
