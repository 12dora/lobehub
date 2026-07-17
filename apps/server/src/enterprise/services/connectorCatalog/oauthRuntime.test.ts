// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { PlatformConnectorContractError } from './errors';
import { getConnectorOAuthRuntime } from './oauthRuntime';

const masterKey = Buffer.alloc(32, 7).toString('base64');
const db = {} as LobeChatDatabase;

describe('getConnectorOAuthRuntime', () => {
  it('constructs independent production dependencies in a fresh feature-on process', () => {
    const env = {
      APP_URL: 'https://aihub.example.test/base',
      ENABLE_PLATFORM_MANAGED_CONNECTORS: '1',
      PLATFORM_MASTER_KEY: masterKey,
      PLATFORM_MASTER_KEY_ID: 'runtime:key-1',
    };
    const first = getConnectorOAuthRuntime(db, env);
    const second = getConnectorOAuthRuntime(db, env);

    expect(first.callbackRedirectUri).toBe('https://aihub.example.test/oauth/connector/callback');
    expect(first.secrets).not.toBe(second.secrets);
    expect(first.outbound).not.toBe(second.outbound);
  });

  it('fails closed without the M13 master key and never accepts OAuth secrets from env', () => {
    expect(() =>
      getConnectorOAuthRuntime(db, {
        APP_URL: 'https://aihub.example.test',
        ENABLE_PLATFORM_MANAGED_CONNECTORS: '1',
      }),
    ).toThrow();
    expect(() =>
      getConnectorOAuthRuntime(db, {
        APP_URL: 'https://aihub.example.test',
        CONNECTOR_OAUTH_TOKEN: 'must-not-be-consumed',
        ENABLE_PLATFORM_MANAGED_CONNECTORS: '1',
        PLATFORM_MASTER_KEY: masterKey,
      }),
    ).not.toThrow(PlatformConnectorContractError);
  });
});
