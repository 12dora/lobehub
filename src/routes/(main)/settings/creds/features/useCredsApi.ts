'use client';

import { createContext, useContext } from 'react';

import { lambdaClient, lambdaQuery } from '@/libs/trpc/client';

/**
 * Personal / workspace / platform-admin creds API binding.
 *
 * The personal page (`/settings/creds`) and the workspace page
 * (`/[workspaceSlug]/settings/creds`) share UI components but talk to
 * different tRPC routers — `market.creds` (Market user account) versus
 * `workspaceCreds` (Market organization mirroring the cloud workspace).
 *
 * The `'platform'` {@link CredsApi.mode} rebinds the same UI to admin-owned
 * global credentials (`admin.creds`) so Market auth and OAuth creation are
 * skipped and the view never reveals plaintext.
 *
 * The workspace shell wraps the page in {@link CredsApiProvider}. Forms/modals
 * read whichever client/query namespace is active via {@link useCredsApi} and
 * otherwise behave identically.
 */
export type CredsApiMode = 'market' | 'platform';

export interface CredsApi {
  client: typeof lambdaClient.market.creds;
  /**
   * `market` (default): personal/workspace Market cloud credentials.
   * `platform`: admin-owned global credentials (no Market sign-in, no OAuth,
   * view is mask-only / configured).
   */
  mode?: CredsApiMode;
  query: typeof lambdaQuery.market.creds;
}

const defaultCredsApi: CredsApi = {
  client: lambdaClient.market.creds,
  mode: 'market',
  query: lambdaQuery.market.creds,
};

const CredsApiContext = createContext<CredsApi | null>(null);

export const CredsApiProvider = CredsApiContext.Provider;

export const useCredsApi = (): CredsApi => useContext(CredsApiContext) ?? defaultCredsApi;

/** True when the active CredsApi is the admin platform binding. */
export const isPlatformCredsMode = (api: CredsApi): boolean => api.mode === 'platform';
