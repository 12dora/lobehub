// @vitest-environment node
import { vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import type { LobeChatDatabase } from '@/database/type';

import { connectorToolFixture, MemoryConnectorSecretStore } from './catalogTestUtils';
import type {
  ConnectorOutboundClient,
  ConnectorOutboundJsonResponse,
} from './connectorOutboundClient';
import { ConnectorCatalogDraftService } from './draftService';
import type { ConnectorOAuthOutboundAdapter } from './oauthOutboundAdapter';
import type { ConnectorOAuthRuntimeDependencies } from './oauthRuntime';
import { ConnectorCatalogPublicationService } from './publicationService';
import { ConnectorOAuthCallbackService, UserConnectorOAuthService } from './userOAuthService';

export const db: LobeChatDatabase = await getTestDB();
export const callbackRedirectUri = 'https://aihub.example.test/oauth/connector/callback';
export const userA = 'm09-service-user-oauth-a';
export const userB = 'm09-service-user-oauth-b';

export const createHarness = () => {
  const secrets = new MemoryConnectorSecretStore(db);
  const catalogOutbound = {
    getPolicyVersion: () => 1,
    preflight: vi.fn(async () => ({ policyVersion: 1 })),
  } as unknown as ConnectorOutboundClient;
  const preflightAuthorization = vi.fn(async () => {});
  const preflightToken = vi.fn(async () => {});
  const exchangeCode = vi.fn(
    async (_request: {
      clientId: string;
      clientSecret?: string;
      code: string;
      codeVerifier: string;
      redirectUri: string;
      tokenEndpoint: string;
    }): Promise<ConnectorOutboundJsonResponse> => ({
      body: {
        access_token: 'provider-access-token-v1',
        expires_in: 3600,
        refresh_token: 'provider-refresh-token-v1',
        scope: 'issues:read',
        token_type: 'Bearer',
      },
      status: 200,
      url: 'https://identity.example.test/oauth/token',
    }),
  );
  const refresh = vi.fn(
    async (_request: {
      clientId: string;
      clientSecret?: string;
      refreshToken: string;
      tokenEndpoint: string;
    }): Promise<ConnectorOutboundJsonResponse> => ({
      body: {
        access_token: 'provider-access-token-v2',
        expires_in: 7200,
        refresh_token: 'provider-refresh-token-v2',
        scope: 'issues:read',
        token_type: 'Bearer',
      },
      status: 200,
      url: 'https://identity.example.test/oauth/token',
    }),
  );
  const outbound = {
    exchangeCode,
    preflightAuthorization,
    preflightToken,
    refresh,
  } as unknown as ConnectorOAuthOutboundAdapter;
  const dependencies: ConnectorOAuthRuntimeDependencies = {
    callbackRedirectUri,
    outbound,
    secrets,
  };
  return {
    callback: new ConnectorOAuthCallbackService(db, dependencies),
    dependencies,
    drafts: new ConnectorCatalogDraftService(db, secrets, callbackRedirectUri),
    exchangeCode,
    preflightAuthorization,
    preflightToken,
    publication: new ConnectorCatalogPublicationService(db, catalogOutbound, secrets, {}),
    refresh,
    secrets,
    userA: new UserConnectorOAuthService(db, userA, dependencies),
    userB: new UserConnectorOAuthService(db, userB, dependencies),
  };
};

export const publishOAuthConnector = async (harness: ReturnType<typeof createHarness>) => {
  const draft = await harness.drafts.createDraft('admin-user', {
    credentialMode: 'per_user_oauth',
    displayName: 'Managed Issues',
    enabled: true,
    endpoint: 'https://connector.example.test/mcp',
    key: 'managed-issues',
    oauthClientSecret: { operation: 'replace', value: 'provider-client-secret' },
    oauthConfig: {
      authorizationEndpoint: 'https://identity.example.test/oauth/authorize',
      clientId: 'managed-client-id',
      issuer: 'https://identity.example.test',
      scopes: ['issues:read'],
      tokenEndpoint: 'https://identity.example.test/oauth/token',
    },
    reason: 'create OAuth connector',
    tools: [connectorToolFixture()],
    transport: 'http',
  });
  await harness.publication.publish('admin-user', {
    expectedDraftToken: draft.draftToken,
    expectedRevision: 0,
    id: draft.draft.id,
    reason: 'publish OAuth connector',
  });
  return harness.drafts.getDraft(draft.draft.id);
};

export const start = async (
  harness: ReturnType<typeof createHarness>,
  connectorId: string,
  returnTo = '/settings/connectors',
) => {
  const result = await harness.userA.startAuthorization({ connectorId, returnTo });
  const url = new URL(result.authorizationUrl);
  return {
    challenge: url.searchParams.get('code_challenge')!,
    result,
    state: url.searchParams.get('state')!,
    url,
  };
};
