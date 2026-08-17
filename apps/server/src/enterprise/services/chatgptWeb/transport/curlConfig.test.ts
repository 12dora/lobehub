import {
  DEFAULT_BROWSER_DEVICE_PROFILE,
  NAVIGATION_ONLY_HEADERS,
} from '@lobechat/model-runtime/browserProfile';
import {
  buildBootstrapHeaders,
  buildSessionHeaders,
} from '@lobechat/model-runtime/chatgptWebIdentity';
import { describe, expect, it } from 'vitest';

import { buildInvocation, DEFAULT_IMPERSONATE_PROFILE } from './curlConfig';

const invocationOf = (headers: Record<string, string>) =>
  buildInvocation({
    headers: Object.entries(headers),
    impersonate: DEFAULT_IMPERSONATE_PROFILE,
    method: 'GET',
    timeoutMs: 30_000,
    url: 'https://chatgpt.com/backend-api/me',
  });

const configLines = (config: string) => config.split('\n').filter(Boolean);

describe('buildInvocation header deletion', () => {
  it('renders an empty header value as Name: (delete), not Name; (send-empty)', () => {
    const { config } = buildInvocation({
      headers: [
        ['Accept', '*/*'],
        ['Sec-Fetch-User', ''],
        ['Upgrade-Insecure-Requests', ''],
      ],
      impersonate: 'chrome150',
      method: 'GET',
      timeoutMs: 1000,
      url: 'https://chatgpt.com/backend-api/me',
    });
    const lines = configLines(config);

    expect(lines).toContain('header = "Sec-Fetch-User:"');
    expect(lines).toContain('header = "Upgrade-Insecure-Requests:"');
    expect(lines).toContain('header = "Accept: */*"');
    expect(lines.some((line) => line.includes('Sec-Fetch-User;'))).toBe(false);
    expect(lines.some((line) => line.includes('Upgrade-Insecure-Requests;'))).toBe(false);
  });

  it('renders dropHeaders as Name: even when they are absent from the send list', () => {
    const { config } = buildInvocation({
      dropHeaders: ['Sec-Fetch-User', 'Upgrade-Insecure-Requests'],
      headers: [['Accept', '*/*']],
      impersonate: 'chrome150',
      method: 'GET',
      timeoutMs: 1000,
      url: 'https://chatgpt.com/backend-api/me',
    });
    const lines = configLines(config);

    expect(lines).toContain('header = "Sec-Fetch-User:"');
    expect(lines).toContain('header = "Upgrade-Insecure-Requests:"');
  });

  it('XHR session builder emits the navigation-header drop markers', () => {
    const { config } = invocationOf(
      buildSessionHeaders({
        accessToken: 'tok',
        browserProfile: DEFAULT_BROWSER_DEVICE_PROFILE,
        deviceId: 'dev',
        sessionId: 'sess',
      }),
    );
    const lines = configLines(config);

    expect(lines).toContain('header = "Sec-Fetch-User:"');
    expect(lines).toContain('header = "Upgrade-Insecure-Requests:"');
    expect(lines.includes('header = "Sec-Fetch-User: ?1"')).toBe(false);
    expect(lines.includes('header = "Upgrade-Insecure-Requests: 1"')).toBe(false);
    for (const name of NAVIGATION_ONLY_HEADERS) {
      expect(lines).toContain(`header = "${name}:"`);
    }
  });

  it('bootstrap navigation builder keeps Sec-Fetch-User and Upgrade-Insecure-Requests', () => {
    const { config } = invocationOf(
      buildBootstrapHeaders({
        accessToken: 'tok',
        browserProfile: DEFAULT_BROWSER_DEVICE_PROFILE,
        deviceId: 'dev',
        sessionId: 'sess',
      }),
    );
    const lines = configLines(config);

    expect(lines).toContain('header = "Sec-Fetch-User: ?1"');
    expect(lines).toContain('header = "Upgrade-Insecure-Requests: 1"');
    expect(lines).not.toContain('header = "Sec-Fetch-User:"');
    expect(lines).not.toContain('header = "Upgrade-Insecure-Requests:"');
  });

  it('uses the shared fallback profile when no persisted profile is supplied', () => {
    expect(DEFAULT_IMPERSONATE_PROFILE).toBe(DEFAULT_BROWSER_DEVICE_PROFILE.impersonateProfile);
  });

  it('emits cookie and cookie-jar config lines only when a jar path is set', () => {
    const without = buildInvocation({
      headers: [['Accept', '*/*']],
      impersonate: 'chrome150',
      method: 'GET',
      timeoutMs: 1000,
      url: 'https://chatgpt.com/',
    });
    expect(configLines(without.config).some((line) => line.startsWith('cookie'))).toBe(false);

    const withJar = buildInvocation({
      cookieJarPath: '/tmp/aihub-chatgptweb-jars/example.txt',
      headers: [['Accept', '*/*']],
      impersonate: 'chrome150',
      method: 'GET',
      timeoutMs: 1000,
      url: 'https://chatgpt.com/',
    });
    const lines = configLines(withJar.config);
    expect(lines).toContain('cookie = "/tmp/aihub-chatgptweb-jars/example.txt"');
    expect(lines).toContain('cookie-jar = "/tmp/aihub-chatgptweb-jars/example.txt"');
  });
});
