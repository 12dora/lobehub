// @vitest-environment node

import { EventEmitter } from 'node:events';
import type { IncomingMessage, RequestOptions } from 'node:http';
import https from 'node:https';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultPinnedTransport, resolvePinnedTransportRoute } from './transport';

const route = (input: { env?: NodeJS.Dict<string>; pinnedAddress?: string; url?: string }) =>
  resolvePinnedTransportRoute({
    env: input.env ?? {},
    pinnedAddress: input.pinnedAddress ?? '8.8.8.8',
    url: new URL(input.url ?? 'https://login.example.test/'),
  });

const envProxy = {
  HTTPS_PROXY: 'http://proxy.corp.test:8080',
  NODE_USE_ENV_PROXY: '1',
} as const;

describe('resolvePinnedTransportRoute', () => {
  it('goes direct when env proxying is off', () => {
    expect(route({ env: {} })).toBe('direct');
    expect(
      route({
        env: { HTTPS_PROXY: 'http://proxy.corp.test:8080', NODE_USE_ENV_PROXY: '0' },
      }),
    ).toBe('direct');
  });

  it('goes direct when NODE_USE_ENV_PROXY is unset even if HTTPS_PROXY is set', () => {
    expect(route({ env: { HTTPS_PROXY: 'http://proxy.corp.test:8080' } })).toBe('direct');
  });

  it('goes direct when no proxy URL is configured for the URL scheme', () => {
    expect(
      route({
        env: { HTTP_PROXY: 'http://proxy.corp.test:8080', NODE_USE_ENV_PROXY: '1' },
      }),
    ).toBe('direct');
  });

  it('goes direct when NODE_USE_ENV_PROXY=1 and HTTPS_PROXY are set but the pinned IP is private', () => {
    expect(
      route({
        env: envProxy,
        pinnedAddress: '172.17.0.1',
        url: 'https://auth.jiefakj.com/.well-known/openid-configuration',
      }),
    ).toBe('direct');
  });

  it('goes direct when NO_PROXY matches the original hostname', () => {
    expect(
      route({
        env: { ...envProxy, NO_PROXY: 'login.example.test' },
        pinnedAddress: '8.8.8.8',
      }),
    ).toBe('direct');
  });

  it('goes direct when NO_PROXY is a wildcard or exact pinned IP', () => {
    expect(route({ env: { ...envProxy, NO_PROXY: '*' }, pinnedAddress: '8.8.8.8' })).toBe('direct');
    expect(
      route({
        env: { ...envProxy, NO_PROXY: '8.8.8.8' },
        pinnedAddress: '8.8.8.8',
      }),
    ).toBe('direct');
  });

  it('goes direct when NO_PROXY matches a domain suffix with or without a leading dot', () => {
    expect(
      route({
        env: { ...envProxy, NO_PROXY: '.example.test' },
        pinnedAddress: '1.1.1.1',
        url: 'https://login.example.test/',
      }),
    ).toBe('direct');
    expect(
      route({
        env: { ...envProxy, no_proxy: 'example.test' },
        pinnedAddress: '1.1.1.1',
        url: 'https://login.example.test/',
      }),
    ).toBe('direct');
  });

  it('goes direct when NO_PROXY CIDR matches the pinned IP', () => {
    expect(
      route({
        env: { ...envProxy, NO_PROXY: '8.8.8.0/24' },
        pinnedAddress: '8.8.8.8',
      }),
    ).toBe('direct');
    expect(
      route({
        env: { ...envProxy, NO_PROXY: '2606:4700::/32' },
        pinnedAddress: '2606:4700:4700::1111',
        url: 'https://one.one.one.one/',
      }),
    ).toBe('direct');
  });

  it('goes via the env proxy for a public pinned IP with no exemption', () => {
    expect(
      route({
        env: envProxy,
        pinnedAddress: '8.8.8.8',
        url: 'https://login.example.test/',
      }),
    ).toBe('proxy');
  });
});

describe('defaultPinnedTransport env-proxy agents', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const mockHttpsRequest = () => {
    const requestSpy = vi.spyOn(https, 'request').mockImplementation(((
      options: RequestOptions,
      callback?: (res: IncomingMessage) => void,
    ) => {
      const request = new EventEmitter() as ReturnType<typeof https.request>;
      request.destroy = vi.fn() as typeof request.destroy;
      request.write = vi.fn() as typeof request.write;
      request.end = (() => {
        queueMicrotask(() => {
          const incoming = new EventEmitter() as IncomingMessage;
          incoming.headers = {};
          incoming.statusCode = 200;
          incoming.statusMessage = 'OK';
          callback?.(incoming);
          incoming.emit('end');
        });
        return request;
      }) as typeof request.end;
      return request;
    }) as typeof https.request);
    return requestSpy;
  };

  it('direct route passes an explicit Agent and connects to the pinned IP', async () => {
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.corp.test:8080');
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    const requestSpy = mockHttpsRequest();

    await defaultPinnedTransport({
      family: 4,
      headers: {},
      maxResponseBytes: 1024,
      method: 'GET',
      pinnedAddress: '172.17.0.1',
      timeoutMs: 1_000,
      url: new URL('https://auth.jiefakj.com/.well-known/openid-configuration'),
    });

    expect(requestSpy).toHaveBeenCalledOnce();
    const options = requestSpy.mock.calls[0]![0] as https.RequestOptions;
    expect(options.hostname).toBe('172.17.0.1');
    expect(options.agent).toBeInstanceOf(https.Agent);
    const directAgent = options.agent as https.Agent;
    expect(directAgent.options.proxyEnv).toBeUndefined();
    expect(directAgent.options.keepAlive).toBe(true);
  });

  it('proxy route pins the IP with a proxyEnv agent', async () => {
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.corp.test:8080');
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    const requestSpy = mockHttpsRequest();

    await defaultPinnedTransport({
      family: 4,
      headers: {},
      maxResponseBytes: 1024,
      method: 'GET',
      pinnedAddress: '8.8.8.8',
      timeoutMs: 1_000,
      url: new URL('https://login.example.test/authorize'),
    });

    expect(requestSpy).toHaveBeenCalledOnce();
    const options = requestSpy.mock.calls[0]![0] as https.RequestOptions;
    expect(options.hostname).toBe('8.8.8.8');
    expect(options.agent).toBeInstanceOf(https.Agent);
    const proxyAgent = options.agent as https.Agent;
    expect(proxyAgent.options.proxyEnv).toBe(process.env);
    expect(proxyAgent.options.keepAlive).toBe(true);
  });
});
