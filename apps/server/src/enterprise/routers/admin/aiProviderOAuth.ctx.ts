import type { LobeChatDatabase } from '@/database/type';
import type { AuthMethod } from '@/libs/trpc/lambda/context';

export type AiProviderOAuthCtx = {
  authenticatedAt?: Date | null;
  authMethod?: AuthMethod;
  serverDB: LobeChatDatabase;
  userId?: string | null;
};
