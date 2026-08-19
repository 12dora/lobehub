import { describe, expect, it } from 'vitest';

import { DEFAULT_BROWSER_DEVICE_PROFILE, generateBrowserDeviceProfile } from '../../browserProfile';
import { ChatGPTWebClient } from './client';
import { COOKIE_JAR_HEADER, deriveSessionId } from './sessionId';

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

/** Stands in for the installation's persisted profile. */
const browserProfile = generateBrowserDeviceProfile({ seed: 'session-id-installation' });

describe('deriveSessionId', () => {
  it('is stable within one process per device/profile and UUIDv4-shaped', () => {
    const deviceId = '3f7c0f7a-6f6e-4a1b-9c2d-8e5a1b2c3d4e';
    const first = deriveSessionId(deviceId);

    expect(first).toBe(deriveSessionId(deviceId));
    expect(first).toMatch(UUID_RE);
    expect(deriveSessionId('other-device')).not.toBe(first);
    expect(
      deriveSessionId(deviceId, generateBrowserDeviceProfile({ seed: 'new-installation' })),
    ).not.toBe(first);
  });
});

describe('ChatGPTWebHttp session identity', () => {
  it('derives OAI-Session-Id from a vault deviceId and attaches the jar header', async () => {
    const deviceId = 'device-stable';
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('OAI-Session-Id')).toBe(deriveSessionId(deviceId, browserProfile));
      expect(headers.get(COOKIE_JAR_HEADER)).toBe(deviceId);
      return new Response('{}', { headers: { 'content-type': 'application/json' }, status: 200 });
    };

    const client = new ChatGPTWebClient({
      accessToken: 'token',
      browserProfile,
      deviceId,
      fetch: fetchImpl as typeof fetch,
    });

    expect(client.sessionId).toBe(deriveSessionId(deviceId, browserProfile));
    await client.getMe();
  });

  it('keeps a random session id and no jar header when deviceId is absent', async () => {
    const seen: string[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get(COOKIE_JAR_HEADER)).toBeNull();
      seen.push(headers.get('OAI-Session-Id') ?? '');
      return new Response('{}', { headers: { 'content-type': 'application/json' }, status: 200 });
    };

    const a = new ChatGPTWebClient({
      accessToken: 'token',
      browserProfile,
      fetch: fetchImpl as typeof fetch,
    });
    const b = new ChatGPTWebClient({
      accessToken: 'token',
      browserProfile,
      fetch: fetchImpl as typeof fetch,
    });

    expect(a.sessionId).not.toBe(b.sessionId);
    await a.getMe();
    expect(seen[0]).toBe(a.sessionId);
  });

  it('attaches the jar header only on chatgpt.com, not on cross-origin assets', async () => {
    const deviceId = 'device-stable';
    const seen: Array<{ jar: string | null; url: string }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ jar: headers.get(COOKIE_JAR_HEADER), url: String(url) });
      if (String(url).includes('/backend-api/me')) {
        return new Response('{}', {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      }
      return new Response(new Uint8Array([1]), {
        headers: { 'content-type': 'image/png' },
        status: 200,
      });
    };

    const client = new ChatGPTWebClient({
      accessToken: 'token',
      browserProfile,
      deviceId,
      fetch: fetchImpl as typeof fetch,
    });

    await client.getMe();
    await client.downloadBytes('https://chatgpt.com/backend-api/estuary/content?id=1');
    await client.downloadBytes('https://oaiusercontent.blob.core.windows.net/signed');

    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ jar: deviceId });
    expect(seen[1]).toMatchObject({ jar: deviceId });
    expect(seen[2]).toMatchObject({ jar: null });
    expect(seen[2].url).toContain('blob.core.windows.net');
  });

  it('sends no jar while running on the degraded fallback identity', async () => {
    // The jar's cf_clearance was minted under the persisted UA; replaying it behind the
    // fallback UA/TLS profile is exactly the mismatch that triggers a challenge.
    const deviceId = 'device-stable';
    const seen: Array<string | null> = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get(COOKIE_JAR_HEADER));
      return new Response('{}', { headers: { 'content-type': 'application/json' }, status: 200 });
    };

    const client = new ChatGPTWebClient({
      accessToken: 'token',
      browserProfile: DEFAULT_BROWSER_DEVICE_PROFILE,
      deviceId,
      fetch: fetchImpl as typeof fetch,
    });

    await client.getMe();

    expect(seen).toEqual([null]);
  });
});
