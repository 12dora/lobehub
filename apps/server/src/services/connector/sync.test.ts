import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecryptedConnector } from '@/database/models/connector';
import type { ConnectorCredentials } from '@/database/schemas';

import {
  buildConnectorMcpParams,
  buildHttpAuthFromCredentials,
  syncConnectorToolsById,
} from './sync';

const mocks = vi.hoisted(() => ({ assertRuntimeAllowed: vi.fn(async () => {}) }));

vi.mock('@/server/enterprise/services/connectorCatalog/runtimeIntegration', () => ({
  assertLegacyConnectorRuntimeAllowed: mocks.assertRuntimeAllowed,
}));

const httpConnector = (
  credentials: ConnectorCredentials | null,
  metadata?: Record<string, unknown>,
): DecryptedConnector =>
  ({
    credentials,
    id: 'c1',
    identifier: 'my-conn',
    isEnabled: true,
    mcpConnectionType: 'http',
    mcpServerUrl: 'https://mcp.example.com',
    mcpStdioConfig: null,
    metadata: metadata ?? null,
    name: 'My Connector',
    oidcConfig: null,
  }) as any;

beforeEach(() => {
  mocks.assertRuntimeAllowed.mockReset().mockResolvedValue(undefined);
});

describe('buildHttpAuthFromCredentials', () => {
  it('returns nothing for no credentials (no-auth)', () => {
    expect(buildHttpAuthFromCredentials(null)).toEqual({});
  });

  it('maps oauth2 to bearer auth with refresh metadata', () => {
    const result = buildHttpAuthFromCredentials({
      accessToken: 'access',
      clientSecret: 'secret',
      expiresAt: 123,
      refreshToken: 'refresh',
      type: 'oauth2',
    });

    expect(result).toEqual({
      auth: {
        accessToken: 'access',
        clientId: undefined,
        clientSecret: 'secret',
        refreshToken: 'refresh',
        tokenExpiresAt: 123,
        type: 'oauth2',
      },
    });
    expect(result.headers).toBeUndefined();
  });

  it('maps a bearer token to bearer auth', () => {
    expect(buildHttpAuthFromCredentials({ token: 'tok', type: 'bearer' })).toEqual({
      auth: { token: 'tok', type: 'bearer' },
    });
  });

  it('maps an api key to bearer auth (Authorization header)', () => {
    expect(buildHttpAuthFromCredentials({ apiKey: 'key-123', type: 'apikey' })).toEqual({
      auth: { token: 'key-123', type: 'bearer' },
    });
  });

  it('passes custom headers through verbatim with no auth', () => {
    const result = buildHttpAuthFromCredentials({
      headers: { 'X-Api-Key': 'abc', 'X-Tenant': 't1' },
      type: 'header',
    });

    expect(result).toEqual({ headers: { 'X-Api-Key': 'abc', 'X-Tenant': 't1' } });
    expect(result.auth).toBeUndefined();
  });
});

describe('buildConnectorMcpParams', () => {
  it('builds http params with bearer auth', () => {
    expect(buildConnectorMcpParams(httpConnector({ token: 'tok', type: 'bearer' }))).toEqual({
      auth: { token: 'tok', type: 'bearer' },
      headers: undefined,
      name: 'My Connector',
      type: 'http',
      url: 'https://mcp.example.com',
    });
  });

  it('builds http params with custom headers and no auth', () => {
    expect(
      buildConnectorMcpParams(
        httpConnector({ headers: { Authorization: 'Token x' }, type: 'header' }),
      ),
    ).toEqual({
      auth: undefined,
      headers: { Authorization: 'Token x' },
      name: 'My Connector',
      type: 'http',
      url: 'https://mcp.example.com',
    });
  });

  it('merges metadata.customHeaders alongside bearer auth', () => {
    expect(
      buildConnectorMcpParams(
        httpConnector({ token: 'tok', type: 'bearer' }, { customHeaders: { 'X-Tenant': 't1' } }),
      ),
    ).toEqual({
      auth: { token: 'tok', type: 'bearer' },
      headers: { 'X-Tenant': 't1' },
      name: 'My Connector',
      type: 'http',
      url: 'https://mcp.example.com',
    });
  });

  it('applies metadata.customHeaders with no auth credential', () => {
    expect(
      buildConnectorMcpParams(httpConnector(null, { customHeaders: { 'X-Api-Key': 'abc' } })),
    ).toEqual({
      auth: undefined,
      headers: { 'X-Api-Key': 'abc' },
      name: 'My Connector',
      type: 'http',
      url: 'https://mcp.example.com',
    });
  });

  it('lets metadata.customHeaders override legacy header-credential keys', () => {
    expect(
      buildConnectorMcpParams(
        httpConnector(
          { headers: { Authorization: 'Token old' }, type: 'header' },
          { customHeaders: { Authorization: 'Token new' } },
        ),
      ),
    ).toEqual({
      auth: undefined,
      headers: { Authorization: 'Token new' },
      name: 'My Connector',
      type: 'http',
      url: 'https://mcp.example.com',
    });
  });

  it('builds http params with no auth when credentials are absent', () => {
    expect(buildConnectorMcpParams(httpConnector(null))).toEqual({
      auth: undefined,
      headers: undefined,
      name: 'My Connector',
      type: 'http',
      url: 'https://mcp.example.com',
    });
  });

  it('builds stdio params from stdio config', () => {
    const connector = {
      credentials: null,
      identifier: 'local-conn',
      mcpConnectionType: 'stdio',
      mcpServerUrl: null,
      mcpStdioConfig: { args: ['serve'], command: 'my-mcp', env: { FOO: 'bar' } },
      name: 'Local Connector',
    } as any;

    expect(buildConnectorMcpParams(connector)).toEqual({
      args: ['serve'],
      command: 'my-mcp',
      env: { FOO: 'bar' },
      name: 'Local Connector',
      type: 'stdio',
    });
  });
});

describe('syncConnectorToolsById managed transport guard', () => {
  it('rejects stdio in the web service even when legacy transport is allowed', async () => {
    const connectorModel = {
      findById: vi.fn().mockResolvedValue({
        mcpConnectionType: 'stdio',
        mcpStdioConfig: { args: [], command: 'dangerous-child-process' },
      }),
    };

    await expect(
      syncConnectorToolsById('connector-1', {
        connectorModel,
        connectorToolModel: { upsertMany: vi.fn() },
      } as any),
    ).rejects.toThrow('PLATFORM_CONNECTOR_STDIO_UNSUPPORTED');
  });

  it.each(['http', 'stdio'] as const)(
    'blocks legacy %s discovery before reading credentials or starting MCP',
    async () => {
      mocks.assertRuntimeAllowed.mockRejectedValueOnce(new Error('PLATFORM_CONNECTOR_TOOL_DENIED'));
      const connectorModel = { findById: vi.fn() };
      const connectorToolModel = { upsertMany: vi.fn() };

      await expect(
        syncConnectorToolsById('connector-1', {
          connectorModel,
          connectorToolModel,
        } as any),
      ).rejects.toThrow('PLATFORM_CONNECTOR_TOOL_DENIED');

      expect(connectorModel.findById).not.toHaveBeenCalled();
      expect(connectorToolModel.upsertMany).not.toHaveBeenCalled();
    },
  );
});
