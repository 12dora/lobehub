// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthDeviceFlowService, OAuthInvalidGrantError, parseJwtExpiry } from '../index';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OAuthDeviceFlowService', () => {
  let service: OAuthDeviceFlowService;

  const mockConfig = {
    clientId: 'test-client-id',
    defaultPollingInterval: 5,
    deviceCodeEndpoint: 'https://example.com/device/code',
    scopes: ['read:user'],
    tokenEndpoint: 'https://example.com/oauth/token',
  };

  beforeEach(() => {
    service = new OAuthDeviceFlowService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('initiateDeviceCode', () => {
    it('should successfully initiate device code flow', async () => {
      const mockResponse = {
        device_code: 'device-code-123',
        expires_in: 900,
        interval: 5,
        user_code: 'ABCD-1234',
        verification_uri: 'https://example.com/device',
      };

      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
        ok: true,
      });

      const result = await service.initiateDeviceCode(mockConfig);

      expect(mockFetch).toHaveBeenCalledWith(
        mockConfig.deviceCodeEndpoint,
        expect.objectContaining({
          body: expect.stringContaining('client_id=test-client-id'),
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          method: 'POST',
        }),
      );

      expect(result).toEqual({
        deviceCode: 'device-code-123',
        expiresIn: 900,
        interval: 5,
        userCode: 'ABCD-1234',
        verificationUri: 'https://example.com/device',
      });
    });

    it('should use verification_url if verification_uri is not present', async () => {
      const mockResponse = {
        device_code: 'device-code-123',
        expires_in: 900,
        interval: 5,
        user_code: 'ABCD-1234',
        verification_url: 'https://example.com/device-alt',
      };

      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
        ok: true,
      });

      const result = await service.initiateDeviceCode(mockConfig);

      expect(result.verificationUri).toBe('https://example.com/device-alt');
    });

    it('should use default polling interval if not provided', async () => {
      const mockResponse = {
        device_code: 'device-code-123',
        expires_in: 900,
        user_code: 'ABCD-1234',
        verification_uri: 'https://example.com/device',
      };

      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
        ok: true,
      });

      const result = await service.initiateDeviceCode(mockConfig);

      expect(result.interval).toBe(5);
    });

    it('should throw error on failed request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad Request'),
      });

      await expect(service.initiateDeviceCode(mockConfig)).rejects.toThrow(
        'Failed to initiate device code: 400 Bad Request',
      );
    });
  });

  describe('pollForToken', () => {
    it('should return success status with tokens on successful authorization', async () => {
      const mockResponse = {
        access_token: 'access-token-123',
        expires_in: 3600,
        refresh_token: 'refresh-token-456',
        scope: 'read:user',
        token_type: 'bearer',
      };

      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
        ok: true,
      });

      const result = await service.pollForToken(mockConfig, 'device-code-123');

      expect(mockFetch).toHaveBeenCalledWith(
        mockConfig.tokenEndpoint,
        expect.objectContaining({
          body: expect.stringContaining('device_code=device-code-123'),
          method: 'POST',
        }),
      );

      expect(result).toEqual({
        status: 'success',
        tokens: {
          accessToken: 'access-token-123',
          expiresIn: 3600,
          refreshToken: 'refresh-token-456',
          scope: 'read:user',
          tokenType: 'bearer',
        },
      });
    });

    it('should return pending status when authorization is pending', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ error: 'authorization_pending' }),
        ok: true,
      });

      const result = await service.pollForToken(mockConfig, 'device-code-123');

      expect(result).toEqual({ status: 'pending' });
    });

    it('should return slow_down status', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ error: 'slow_down' }),
        ok: true,
      });

      const result = await service.pollForToken(mockConfig, 'device-code-123');

      expect(result).toEqual({ status: 'slow_down' });
    });

    it('should return expired status when token expires', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ error: 'expired_token' }),
        ok: true,
      });

      const result = await service.pollForToken(mockConfig, 'device-code-123');

      expect(result).toEqual({ status: 'expired' });
    });

    it('should return denied status when access is denied', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ error: 'access_denied' }),
        ok: true,
      });

      const result = await service.pollForToken(mockConfig, 'device-code-123');

      expect(result).toEqual({ status: 'denied' });
    });

    it('should throw error for unknown OAuth error', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            error: 'unknown_error',
            error_description: 'Something went wrong',
          }),
        ok: true,
      });

      await expect(service.pollForToken(mockConfig, 'device-code-123')).rejects.toThrow(
        'OAuth error: unknown_error - Something went wrong',
      );
    });

    it('should throw error when response has no access_token and no error', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({}),
        ok: true,
      });

      await expect(service.pollForToken(mockConfig, 'device-code-123')).rejects.toThrow(
        'Unexpected response from token endpoint',
      );
    });

    it('should use default token_type as bearer if not provided', async () => {
      const mockResponse = {
        access_token: 'access-token-123',
      };

      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
        ok: true,
      });

      const result = await service.pollForToken(mockConfig, 'device-code-123');

      expect(result.tokens?.tokenType).toBe('bearer');
    });

    const jwt = (claims: Record<string, unknown>) =>
      `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
        JSON.stringify(claims),
      ).toString('base64url')}.sig`;

    it('extracts email and subject from the id_token when present', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            access_token: 'opaque-access',
            id_token: jwt({ email: 'owner@example.test', sub: 'user-1' }),
            token_type: 'bearer',
          }),
        ok: true,
      });

      const result = await service.pollForToken(mockConfig, 'device-code-123');

      expect(result.tokens).toMatchObject({
        accountId: 'user-1',
        email: 'owner@example.test',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('falls back to preferred_username on the access token JWT', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            access_token: jwt({ preferred_username: 'grok-user', sub: 'xai-sub' }),
            token_type: 'bearer',
          }),
        ok: true,
      });

      const result = await service.pollForToken(mockConfig, 'device-code-123');

      expect(result.tokens).toMatchObject({
        accountId: 'xai-sub',
        email: 'grok-user',
      });
    });

    it('asks x.ai userinfo when the access token JWT has no email', async () => {
      const xaiConfig = {
        ...mockConfig,
        tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      };
      const accessToken = jwt({
        aud: 'api',
        client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        iss: 'https://auth.x.ai',
        jti: 'jti-1',
        principal_id: '81f4abc',
        principal_type: 'user',
        scope: 'openid profile email offline_access',
        sub: '81f4abc',
        team_id: 'team-1',
        tier: 'pro',
      });
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ access_token: accessToken, token_type: 'bearer' }),
          ok: true,
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              email: 'user@example.com',
              email_verified: true,
              family_name: '',
              given_name: 'Ada',
              name: 'Ada Lovelace',
              picture: 'https://auth.x.ai/picture',
              sub: '81f4abc',
            }),
          ok: true,
        });

      const result = await service.pollForToken(xaiConfig, 'device-code-123');

      expect(result.tokens).toMatchObject({
        accountId: '81f4abc',
        email: 'user@example.com',
      });
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://auth.x.ai/oauth2/userinfo',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${accessToken}`,
          }),
          method: 'GET',
        }),
      );
    });

    it('asks x.ai userinfo when the access token is opaque', async () => {
      const xaiConfig = {
        ...mockConfig,
        tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      };
      mockFetch
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              access_token: 'opaque-xai-token',
              token_type: 'bearer',
            }),
          ok: true,
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ email: 'xai@example.test', sub: 'xai-sub' }),
          ok: true,
        });

      const result = await service.pollForToken(xaiConfig, 'device-code-123');

      expect(result.tokens).toMatchObject({
        accountId: 'xai-sub',
        email: 'xai@example.test',
      });
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://auth.x.ai/oauth2/userinfo',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer opaque-xai-token',
          }),
          method: 'GET',
        }),
      );
    });

    it('swallows a failed x.ai userinfo call and leaves email unset', async () => {
      const xaiConfig = {
        ...mockConfig,
        tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      };
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ access_token: 'opaque-xai-token', token_type: 'bearer' }),
          ok: true,
        })
        .mockRejectedValueOnce(new Error('userinfo down'));

      const result = await service.pollForToken(xaiConfig, 'device-code-123');

      expect(result.tokens?.email).toBeUndefined();
      expect(result.tokens?.accessToken).toBe('opaque-xai-token');
    });
  });

  describe('refreshAccessToken', () => {
    it('should exchange the refresh token with a refresh_token grant', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            access_token: 'new-access',
            expires_in: 3600,
            refresh_token: 'new-refresh',
            token_type: 'bearer',
          }),
        ok: true,
      });

      const result = await service.refreshAccessToken(mockConfig, 'old-refresh');

      expect(mockFetch).toHaveBeenCalledWith(
        mockConfig.tokenEndpoint,
        expect.objectContaining({
          body: expect.stringContaining('grant_type=refresh_token'),
          method: 'POST',
        }),
      );
      expect(result).toEqual({
        accessToken: 'new-access',
        expiresIn: 3600,
        refreshToken: 'new-refresh',
        scope: undefined,
        tokenType: 'bearer',
      });
    });

    it('bounds x.ai userinfo with the refresh deadline', async () => {
      const xaiConfig = {
        ...mockConfig,
        tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      };
      const deadline = AbortSignal.abort();
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ access_token: 'opaque-xai-token', token_type: 'bearer' }),
          ok: true,
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ email: 'user@example.com', sub: '81f4abc' }),
          ok: true,
        });

      await service.refreshAccessToken(xaiConfig, 'old-refresh', { signal: deadline });

      const userinfoInit = mockFetch.mock.calls[1]?.[1] as { signal?: AbortSignal };
      expect(userinfoInit.signal?.aborted).toBe(true);
    });

    it('extracts email from a refreshed id_token', async () => {
      const idToken = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
        JSON.stringify({ email: 'renewed@example.test' }),
      ).toString('base64url')}.sig`;
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            access_token: 'new-access',
            id_token: idToken,
            token_type: 'bearer',
          }),
        ok: true,
      });

      const result = await service.refreshAccessToken(mockConfig, 'old-refresh');

      expect(result.email).toBe('renewed@example.test');
    });

    it('should fall back to the old refresh token when the provider does not rotate', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ access_token: 'new-access' }),
        ok: true,
      });

      const result = await service.refreshAccessToken(mockConfig, 'old-refresh');

      expect(result.refreshToken).toBe('old-refresh');
    });

    it('should throw OAuthInvalidGrantError on invalid_grant', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ error: 'invalid_grant' }),
        ok: false,
        status: 400,
      });

      await expect(service.refreshAccessToken(mockConfig, 'dead-refresh')).rejects.toBeInstanceOf(
        OAuthInvalidGrantError,
      );
    });

    it('should throw a generic error on other failures', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ error: 'server_error' }),
        ok: false,
        status: 500,
      });

      await expect(service.refreshAccessToken(mockConfig, 'refresh')).rejects.toThrow(
        'Failed to refresh access token',
      );
    });
  });
});

describe('parseJwtExpiry', () => {
  const buildJwt = (claims: object) => {
    const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${encode({ alg: 'none' })}.${encode(claims)}.sig`;
  };

  it('should parse the exp claim as a ms timestamp', () => {
    expect(parseJwtExpiry(buildJwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000);
  });

  it('should return undefined for opaque tokens', () => {
    expect(parseJwtExpiry('gho_notajwt')).toBeUndefined();
  });

  it('should return undefined when exp is missing or malformed', () => {
    expect(parseJwtExpiry(buildJwt({ sub: 'user' }))).toBeUndefined();
    expect(parseJwtExpiry(buildJwt({ exp: 'soon' }))).toBeUndefined();
    expect(parseJwtExpiry(undefined)).toBeUndefined();
    expect(parseJwtExpiry('')).toBeUndefined();
  });
});
