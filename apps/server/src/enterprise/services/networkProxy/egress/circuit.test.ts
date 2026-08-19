import { describe, expect, it } from 'vitest';

import type { ConnectPhaseContext } from './circuit';
import { isConnectPhaseFailure } from './circuit';

const PROXY_URL = 'http://127.0.0.1:18080';
const PROXY_CTX: ConnectPhaseContext = { proxyUrl: PROXY_URL };

describe('isConnectPhaseFailure', () => {
  it.each([
    { ctx: {}, error: null, expected: false, name: 'null' },
    { ctx: {}, error: undefined, expected: false, name: 'undefined' },
    { ctx: {}, error: 'not-an-object', expected: false, name: 'string' },
    { ctx: {}, error: 42, expected: false, name: 'number' },
    { ctx: {}, error: { code: 'CERT_HAS_EXPIRED' }, expected: false, name: 'CERT_HAS_EXPIRED' },
    {
      ctx: { beforeHeaders: false, proxyUrl: PROXY_URL },
      error: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
      expected: false,
      name: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    },
    {
      ctx: { beforeHeaders: false },
      error: { code: 'UND_ERR_SOCKET' },
      expected: false,
      name: 'UND_ERR_SOCKET after headers',
    },
    { ctx: {}, error: { statusCode: 407 }, expected: true, name: 'statusCode 407' },
    { ctx: {}, error: { message: 'proxy 407' }, expected: true, name: 'message proxy 407' },
    {
      ctx: {},
      error: { message: 'Proxy Authentication Required' },
      expected: true,
      name: 'Proxy Authentication Required',
    },
    {
      ctx: { beforeHeaders: true },
      error: { code: 'UND_ERR_CONNECT_TIMEOUT' },
      expected: true,
      name: 'UND_ERR_CONNECT_TIMEOUT before headers',
    },
    {
      ctx: { beforeHeaders: false },
      error: { code: 'UND_ERR_CONNECT_TIMEOUT' },
      expected: false,
      name: 'UND_ERR_CONNECT_TIMEOUT after headers',
    },
    {
      ctx: { beforeHeaders: true },
      error: { code: 'UND_ERR_TLS', message: 'tls to proxy' },
      expected: true,
      name: 'UND_ERR_TLS message mentions proxy',
    },
    {
      ctx: { beforeHeaders: true, proxyUrl: PROXY_URL },
      error: { code: 'UND_ERR_TLS', hostname: '127.0.0.1' },
      expected: true,
      name: 'UND_ERR_TLS failedHost === proxyHost',
    },
    {
      ctx: { beforeHeaders: true },
      error: { code: 'UND_ERR_TLS' },
      expected: false,
      name: 'UND_ERR_TLS no proxy hint',
    },
    {
      ctx: PROXY_CTX,
      error: { code: 'ECONNREFUSED', hostname: '127.0.0.1' },
      expected: true,
      name: 'ECONNREFUSED hosts match',
    },
    {
      ctx: PROXY_CTX,
      error: { code: 'ECONNREFUSED', hostname: 'api.openai.com' },
      expected: false,
      name: 'ECONNREFUSED hosts differ',
    },
    {
      ctx: { beforeHeaders: true },
      error: { code: 'ECONNREFUSED' },
      expected: true,
      name: 'ECONNREFUSED no hosts before headers',
    },
    {
      ctx: { beforeHeaders: false },
      error: { code: 'ECONNREFUSED' },
      expected: false,
      name: 'ECONNREFUSED no hosts after headers',
    },
    {
      ctx: PROXY_CTX,
      error: {
        code: 'ENOTFOUND',
        hostname: 'api.openai.com',
        message: 'getaddrinfo ENOTFOUND api.openai.com',
      },
      expected: false,
      name: 'ENOTFOUND target host',
    },
    {
      ctx: PROXY_CTX,
      error: { code: 'ENOTFOUND', hostname: '127.0.0.1' },
      expected: true,
      name: 'ENOTFOUND failedHost === proxyHost',
    },
    {
      ctx: PROXY_CTX,
      error: { code: 'EAI_AGAIN', hostname: '127.0.0.1' },
      expected: true,
      name: 'EAI_AGAIN hosts match',
    },
    { ctx: {}, error: { message: 'proxy timeout' }, expected: true, name: 'proxy timeout message' },
    {
      ctx: {},
      error: { message: 'proxy handshake' },
      expected: true,
      name: 'proxy handshake message',
    },
    {
      ctx: {},
      error: { code: 'UND_ERR_BODY_TIMEOUT' },
      expected: false,
      name: 'UND_ERR_BODY_TIMEOUT',
    },
  ] satisfies Array<{
    ctx: ConnectPhaseContext;
    error: unknown;
    expected: boolean;
    name: string;
  }>)('$name → $expected', ({ error, ctx, expected }) => {
    expect(isConnectPhaseFailure(error, ctx)).toBe(expected);
  });
});

describe('failedHostOf parsing (via isConnectPhaseFailure host match)', () => {
  it.each([
    {
      error: { code: 'ENOTFOUND', hostname: '127.0.0.1' },
      name: 'hostname',
    },
    {
      error: { code: 'ENOTFOUND', cause: { hostname: '127.0.0.1' } },
      name: 'cause.hostname',
    },
    {
      error: { address: '127.0.0.1', code: 'ECONNREFUSED' },
      name: 'address',
    },
    {
      error: { cause: { address: '127.0.0.1' }, code: 'ECONNREFUSED' },
      name: 'cause.address',
    },
    {
      error: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND 127.0.0.1' },
      name: 'getaddrinfo ENOTFOUND host',
    },
    {
      error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1' },
      name: 'connect ECONNREFUSED host',
    },
  ])('$name matches proxy host', ({ error }) => {
    expect(isConnectPhaseFailure(error, PROXY_CTX)).toBe(true);
  });

  it('IPv6 [::1] via hostOf matches bracketed proxy URL', () => {
    expect(
      isConnectPhaseFailure(
        { code: 'ECONNREFUSED', hostname: '[::1]' },
        { proxyUrl: 'http://[::1]:18080' },
      ),
    ).toBe(true);
  });

  it('hostname wins over a differing address', () => {
    expect(
      isConnectPhaseFailure(
        { address: '8.8.8.8', code: 'ENOTFOUND', hostname: '127.0.0.1' },
        PROXY_CTX,
      ),
    ).toBe(true);
  });
});
