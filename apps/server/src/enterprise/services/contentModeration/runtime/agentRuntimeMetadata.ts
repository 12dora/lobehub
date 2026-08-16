import type { MessageModerationMetadata } from '@lobechat/types';
import { and, eq, sql } from 'drizzle-orm';

import { messages } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { buildWorkspaceWhere } from '@/database/utils/workspace';

import type { ModerationDowngradeMarker } from './types';
import { MODERATION_DOWNGRADE_OPTION_KEY } from './types';

export { MODERATION_DOWNGRADE_OPTION_KEY, type ModerationDowngradeMarker };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const stashModerationDowngrade = (
  options: unknown,
  marker: ModerationDowngradeMarker,
): void => {
  if (!isRecord(options)) return;
  options[MODERATION_DOWNGRADE_OPTION_KEY] = marker;
};

export const readModerationDowngrade = (
  options: unknown,
): ModerationDowngradeMarker | undefined => {
  if (!isRecord(options)) return undefined;
  const value = options[MODERATION_DOWNGRADE_OPTION_KEY];
  if (!isRecord(value) || value.action !== 'downgrade') return undefined;
  if (typeof value.model !== 'string' || typeof value.provider !== 'string') return undefined;
  if (typeof value.originalModel !== 'string' || typeof value.originalProvider !== 'string') {
    return undefined;
  }
  return {
    action: 'downgrade',
    model: value.model,
    originalModel: value.originalModel,
    originalProvider: value.originalProvider,
    provider: value.provider,
    ...(typeof value.category === 'string' ? { category: value.category } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(typeof value.recordId === 'string' ? { recordId: value.recordId } : {}),
  };
};

export const readAssistantMessageId = (options: unknown): string | undefined => {
  if (!isRecord(options)) return undefined;
  const metadata = options.metadata;
  if (!isRecord(metadata)) return undefined;
  return typeof metadata.assistantMessageId === 'string' ? metadata.assistantMessageId : undefined;
};

export const toMessageModerationMetadata = (
  marker: ModerationDowngradeMarker,
): MessageModerationMetadata => ({
  action: 'downgrade',
  model: marker.model,
  originalModel: marker.originalModel,
  originalProvider: marker.originalProvider,
  provider: marker.provider,
  ...(marker.category ? { category: marker.category } : {}),
  ...(marker.message ? { message: marker.message } : {}),
  ...(marker.recordId ? { recordId: marker.recordId } : {}),
});

export const buildModerationMetadataMergeSql = (marker: ModerationDowngradeMarker) => {
  const patch = JSON.stringify({ moderation: toMessageModerationMetadata(marker) });
  return sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${patch}::jsonb`;
};

export interface PersistModerationDowngradeInput {
  db: LobeChatDatabase;
  marker: ModerationDowngradeMarker;
  messageId: string;
  userId: string;
  workspaceId?: string;
}

/**
 * Best-effort atomic write of `metadata.moderation` + the effective model/provider.
 * Uses a single JSONB `||` merge so a concurrent usage persist cannot drop the
 * downgrade notice (MessageModel.update is an unlocked read-merge-write).
 */
export const persistModerationDowngradeBestEffort = async ({
  db,
  marker,
  messageId,
  userId,
  workspaceId,
}: PersistModerationDowngradeInput): Promise<void> => {
  try {
    await db
      .update(messages)
      .set({
        metadata: buildModerationMetadataMergeSql(marker),
        model: marker.model,
        provider: marker.provider,
      })
      .where(
        and(eq(messages.id, messageId), buildWorkspaceWhere({ userId, workspaceId }, messages)),
      );
  } catch (error) {
    console.error('[content-moderation] failed to persist downgrade metadata', {
      code: 'moderation_internal',
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
  }
};
