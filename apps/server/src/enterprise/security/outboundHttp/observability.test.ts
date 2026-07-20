// @vitest-environment node
import { createServer } from 'node:http';

import type { EnterpriseSsrfDenialCategory } from '@lobechat/observability-otel/modules/enterprise-platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import type { EnterpriseObservabilityEvent } from '../../observability';
import {
  NOOP_ENTERPRISE_STRUCTURED_LOGGER,
  setEnterprisePlatformObserverForTest,
  setEnterpriseStructuredLoggerForTest,
} from '../../observability';
import {
  assertHostnamePolicy,
  assertResolvedIpAllowed,
  SafeOutboundHttpClient,
  SafeOutboundHttpError,
} from './index';
import type { PinnedTransport, PinnedTransportResponse } from './types';

const okResponse = (overrides: Partial<PinnedTransportResponse> = {}): PinnedTransportResponse => ({
  body: Buffer.from('{}'),
  headers: {},
  status: 200,
  statusText: 'OK',
  ...overrides,
});

const observedEvents: EnterpriseObservabilityEvent[] = [];

const expectSingleDenial = async (
  action: () => Promise<unknown> | unknown,
  category: EnterpriseSsrfDenialCategory,
): Promise<void> => {
  const initialEventCount = observedEvents.length;
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(SafeOutboundHttpError);
  expect(observedEvents.slice(initialEventCount)).toEqual([{ category, type: 'ssrf_denial' }]);
};

beforeEach(() => {
  observedEvents.length = 0;
  setEnterprisePlatformObserverForTest({ record: (event) => observedEvents.push(event) });
  setEnterpriseStructuredLoggerForTest(NOOP_ENTERPRISE_STRUCTURED_LOGGER);
});

afterEach(() => {
  setEnterprisePlatformObserverForTest(null);
  setEnterpriseStructuredLoggerForTest(null);
  vi.restoreAllMocks();
});

describe('SafeOutboundHttp denial observability', () => {
  it('maps URL, protocol, credential, and DNS denials to closed categories', async () => {
    await expectSingleDenial(() => new SafeOutboundHttpClient().fetch('https://'), 'invalid_url');
    await expectSingleDenial(
      () => new SafeOutboundHttpClient().fetch('file:///etc/passwd'),
      'protocol_denied',
    );
    await expectSingleDenial(
      () => new SafeOutboundHttpClient().fetch('https://user:password@tenant.example/private'),
      'credential_url',
    );
    await expectSingleDenial(
      () =>
        new SafeOutboundHttpClient({ resolve: async () => [], transport: vi.fn() }).fetch(
          'https://tenant.example/path',
        ),
      'dns_unavailable',
    );
  });

  it('maps metadata hostname and IP decisions to one category', async () => {
    const allowPrivate = { allowlist: [], mode: 'allow-private' as const };
    const allowlist = {
      allowlist: ['169.254.169.254', 'metadata.google.internal'],
      mode: 'allowlist' as const,
    };

    await expectSingleDenial(
      () => assertHostnamePolicy('metadata.google.internal', allowPrivate),
      'metadata_endpoint',
    );
    await expectSingleDenial(
      () => assertHostnamePolicy('169.254.169.254', allowlist),
      'metadata_endpoint',
    );
    await expectSingleDenial(
      () => assertResolvedIpAllowed('169.254.169.254', allowPrivate, false),
      'metadata_endpoint',
    );
  });

  it('maps hostname and resolved-IP allowlist decisions to one category', async () => {
    const policy = { allowlist: ['allowed.example'], mode: 'allowlist' as const };

    await expectSingleDenial(
      () => assertHostnamePolicy('tenant.example', policy),
      'allowlist_denied',
    );
    await expectSingleDenial(
      () => assertResolvedIpAllowed('93.184.216.34', policy, false),
      'allowlist_denied',
    );
  });

  it('maps invalid and non-public resolved addresses without exposing them', async () => {
    await expectSingleDenial(
      () =>
        new SafeOutboundHttpClient({
          resolve: async () => [{ address: 'tenant-address', family: 4 }],
          transport: vi.fn(),
        }).fetch('https://tenant.example/path'),
      'invalid_address',
    );
    await expectSingleDenial(
      () =>
        new SafeOutboundHttpClient({
          mode: 'public-only',
          resolve: async () => [{ address: '10.20.30.40', family: 4 }],
          transport: vi.fn(),
        }).fetch('https://tenant.example/path'),
      'non_public_address',
    );

    expect(JSON.stringify(observedEvents)).not.toContain('tenant');
    expect(JSON.stringify(observedEvents)).not.toContain('10.20.30.40');
  });

  it('maps changed and unavailable policy snapshots without exposing policy data', async () => {
    let policyVersion = 0;
    const changedClient = new SafeOutboundHttpClient({
      policyProvider: () => ({
        policy: { allowlist: [], mode: 'allow-private' },
        version: (policyVersion += 1),
      }),
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: vi.fn(),
    });
    await expectSingleDenial(
      () => changedClient.preflight('https://tenant.example/path'),
      'policy_changed',
    );

    const unavailableClient = new SafeOutboundHttpClient({
      policyProvider: () => {
        throw new Error('tenant policy backend unavailable');
      },
      transport: vi.fn(),
    });
    await expectSingleDenial(
      () => unavailableClient.fetch('https://tenant.example/path'),
      'policy_unavailable',
    );
    expect(JSON.stringify(observedEvents)).not.toContain('tenant');
  });

  it('maps buffered redirect limit and secret redirect callsites exactly once', async () => {
    const redirectResponse = okResponse({
      headers: { location: 'https://other.example/next' },
      status: 302,
      statusText: 'Found',
    });
    const transport = vi.fn<PinnedTransport>(async () => redirectResponse);
    const resolve = async () => [{ address: '93.184.216.34', family: 4 as const }];

    await expectSingleDenial(
      () =>
        new SafeOutboundHttpClient({ maxRedirects: 0, resolve, transport }).fetch(
          'https://tenant.example/start',
        ),
      'redirect_limit',
    );
    await expectSingleDenial(
      () =>
        new SafeOutboundHttpClient({ resolve, transport }).fetch('https://tenant.example/start', {
          secretBearing: true,
        }),
      'secret_redirect',
    );
  });

  it('maps streaming redirect limit and secret redirect callsites exactly once', async () => {
    let port = 0;
    const server = createServer((request, response) => {
      const location =
        request.url === '/secret' ? `http://localhost:${port}/target` : '/redirect-loop';
      response.writeHead(302, { Location: location });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server unavailable');
    port = address.port;

    try {
      await expectSingleDenial(
        () =>
          new SafeOutboundHttpClient({ maxRedirects: 0 }).streamFetch(
            `http://127.0.0.1:${port}/redirect-loop`,
          ),
        'redirect_limit',
      );
      await expectSingleDenial(
        () =>
          new SafeOutboundHttpClient().streamFetch(`http://127.0.0.1:${port}/secret`, {
            secretBearing: true,
          }),
        'secret_redirect',
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('maps both immediate and asynchronous timeout paths to deadline_exceeded', async () => {
    await expectSingleDenial(
      () =>
        new SafeOutboundHttpClient({
          resolve: async () => [],
          timeoutMs: 0,
          transport: vi.fn(),
        }).fetch('https://tenant.example/path'),
      'deadline_exceeded',
    );
    await expectSingleDenial(
      () =>
        new SafeOutboundHttpClient({
          resolve: async () => await new Promise(() => {}),
          timeoutMs: 5,
          transport: vi.fn(),
        }).fetch('https://tenant.example/path'),
      'deadline_exceeded',
    );
  });

  it('preserves the stable error when the observer throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    setEnterprisePlatformObserverForTest({
      record: () => {
        throw new Error('observer tenant detail');
      },
    });

    let thrown: unknown;
    try {
      await new SafeOutboundHttpClient().fetch('file:///private/path');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
      details: { protocol: 'file:' },
      message: 'SSRF blocked: protocol not allowed: file:',
      name: 'SafeOutboundHttpError',
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('observer tenant detail');
  });
});
