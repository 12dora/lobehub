/**
 * Admin platform-global credentials client.
 *
 * Structural mirror of market.creds for CredsApi rebinding. Mutations are
 * wrapped with admin reauth retry so M13 dangerous ops complete after a
 * re-authentication popup when the session is stale.
 */
import { lambdaClient, lambdaQuery } from '@/libs/trpc/client';

import { withAdminReauthRetry } from '../features/admin/reauth/requestAdminReauth';

type AdminCredsClient = typeof lambdaClient.admin.creds;
type AdminCredsQuery = typeof lambdaQuery.admin.creds;

const rawClient = lambdaClient.admin.creds;

const wrapMutation = <TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
): ((...args: TArgs) => Promise<TResult>) => {
  return (...args: TArgs) => withAdminReauthRetry(() => fn(...args));
};

/**
 * Mutation-wrapped admin.creds client. Queries stay direct.
 * Cast at the CredsApi boundary (same pattern as workspaceCreds).
 */
export const adminCredsClient = {
  createFile: { mutate: wrapMutation(rawClient.createFile.mutate.bind(rawClient.createFile)) },
  createKV: { mutate: wrapMutation(rawClient.createKV.mutate.bind(rawClient.createKV)) },
  createOAuth: { mutate: wrapMutation(rawClient.createOAuth.mutate.bind(rawClient.createOAuth)) },
  delete: { mutate: wrapMutation(rawClient.delete.mutate.bind(rawClient.delete)) },
  deleteByKey: { mutate: wrapMutation(rawClient.deleteByKey.mutate.bind(rawClient.deleteByKey)) },
  get: rawClient.get,
  getByKey: rawClient.getByKey,
  getSkillCredStatus: rawClient.getSkillCredStatus,
  list: rawClient.list,
  listOAuthConnections: rawClient.listOAuthConnections,
  update: { mutate: wrapMutation(rawClient.update.mutate.bind(rawClient.update)) },
  uploadFile: { mutate: wrapMutation(rawClient.uploadFile.mutate.bind(rawClient.uploadFile)) },
} as unknown as AdminCredsClient;

export const adminCredsQuery = lambdaQuery.admin.creds as AdminCredsQuery;

export const adminCredsService = {
  client: adminCredsClient,
  query: adminCredsQuery,
};
