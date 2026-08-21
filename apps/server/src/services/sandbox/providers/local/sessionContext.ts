import { AsyncLocalStorage } from 'node:async_hooks';

export interface LocalSandboxSession {
  topicId: string;
  userId: string;
}

const localSandboxSessionStorage = new AsyncLocalStorage<LocalSandboxSession>();

/**
 * Bind the current sandbox session for the duration of `fn`. Used by
 * `SandboxMiddlewareService` so the singleton local provider (constructed
 * without userId/topicId) still keys containers per (user, topic).
 */
export const runWithLocalSandboxSession = <T>(session: LocalSandboxSession, fn: () => T): T => {
  return localSandboxSessionStorage.run(session, fn);
};

export const getLocalSandboxSession = (): LocalSandboxSession | undefined => {
  return localSandboxSessionStorage.getStore();
};
