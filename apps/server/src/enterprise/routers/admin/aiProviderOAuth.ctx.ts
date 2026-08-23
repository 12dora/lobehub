import type { LobeChatDatabase } from '@/database/type';
import type { AuthMethod } from '@/libs/trpc/lambda/context';

export type AiProviderOAuthCtx = {
  authenticatedAt?: Date | null;
  // `| null` because that is what the request context really carries: an API-key request has no
  // auth method, and a resolver whose ctx cannot represent that is not a resolver tRPC accepts.
  authMethod?: AuthMethod | null;
  serverDB: LobeChatDatabase;
  userId?: string | null;
};
