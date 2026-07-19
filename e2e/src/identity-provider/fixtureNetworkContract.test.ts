import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { AUTHENTIK_FIXTURE_HOST, startAuthentikFixture } from './authentikFixture';
import {
  CANONICAL_FIXTURE_HOST,
  isPinnedFixtureRequest,
  PUBLIC_FIXTURE_ADDRESS,
  redirectPinnedHttpsOptions,
} from './fixtureNetworkContract.mjs';
import { startFixtureProxy } from './fixtureProxy';

const execute = promisify(execFile);

const canonicalRequest = () => ({
  headers: { Host: CANONICAL_FIXTURE_HOST },
  hostname: PUBLIC_FIXTURE_ADDRESS,
  port: 443,
  servername: CANONICAL_FIXTURE_HOST,
});

describe('fixture pinned HTTPS interception contract', () => {
  it('keeps the TLS fixture and preload on one canonical host', () => {
    expect(AUTHENTIK_FIXTURE_HOST).toBe(CANONICAL_FIXTURE_HOST);
    expect(CANONICAL_FIXTURE_HOST).toContain(PUBLIC_FIXTURE_ADDRESS.replaceAll('.', '-'));
  });

  it('patches builtin DNS and pinned node:https before application modules load', async () => {
    const fixture = await startAuthentikFixture({
      clientSecret: 'fixture-network-contract-secret',
      expectedRedirectUri: 'http://localhost/callback',
    });
    const proxy = await startFixtureProxy(fixture.port);
    try {
      const preload = fileURLToPath(new URL('./installFixtureDispatcher.mjs', import.meta.url));
      const probe = `
        import dnsPromises from 'node:dns/promises';
        import https from 'node:https';
        const results = await dnsPromises.lookup(${JSON.stringify(CANONICAL_FIXTURE_HOST)}, { all: true });
        if (JSON.stringify(results) !== ${JSON.stringify(JSON.stringify([{ address: PUBLIC_FIXTURE_ADDRESS, family: 4 }]))}) {
          throw new Error('canonical DNS pin was not installed');
        }
        const body = await new Promise((resolve, reject) => {
          const request = https.request({
            headers: { Host: ${JSON.stringify(CANONICAL_FIXTURE_HOST)} },
            hostname: ${JSON.stringify(PUBLIC_FIXTURE_ADDRESS)},
            path: '/application/o/aihub/.well-known/openid-configuration',
            port: 443,
            servername: ${JSON.stringify(CANONICAL_FIXTURE_HOST)},
          }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          });
          request.on('error', reject);
          request.end();
        });
        const discovery = JSON.parse(body);
        if (discovery.issuer !== ${JSON.stringify(`https://${CANONICAL_FIXTURE_HOST}/application/o/aihub/`)}) {
          throw new Error('pinned HTTPS request did not reach the fixture');
        }
        process.stdout.write('fixture-network-contract-ok');
      `;
      const result = await execute(
        process.execPath,
        ['--import', preload, '--input-type=module', '--eval', probe],
        {
          env: {
            ...process.env,
            E2E_IDP_FIXTURE_PORT: String(fixture.port),
            E2E_IDP_PROXY_URL: proxy.url,
            NODE_EXTRA_CA_CERTS: fixture.caCertificatePath,
          },
          timeout: 15_000,
        },
      );
      expect(result.stdout).toBe('fixture-network-contract-ok');
    } finally {
      await proxy.close();
      await fixture.close();
    }
  });

  it('redirects only the canonical host after the public DNS pin has been preserved', () => {
    const input = canonicalRequest();
    expect(isPinnedFixtureRequest(input)).toBe(true);
    expect(redirectPinnedHttpsOptions(input, 41_234)).toEqual({
      ...input,
      family: 4,
      hostname: '127.0.0.1',
      port: 41_234,
    });
    expect(input).toEqual(canonicalRequest());
  });

  it.each([
    ['different pinned address', { hostname: '1.1.1.1' }],
    ['different SNI', { servername: `other.${CANONICAL_FIXTURE_HOST}` }],
    ['different Host header', { headers: { Host: `other.${CANONICAL_FIXTURE_HOST}` } }],
    ['non-TLS port', { port: 8443 }],
  ])('does not intercept a %s', (_label, override) => {
    const input = { ...canonicalRequest(), ...override };
    expect(isPinnedFixtureRequest(input)).toBe(false);
    expect(redirectPinnedHttpsOptions(input, 41_234)).toBe(input);
  });

  it.each([0, -1, 65_536, Number.NaN])(
    'does not redirect to an invalid fixture port: %s',
    (fixturePort) => {
      const input = canonicalRequest();
      expect(redirectPinnedHttpsOptions(input, fixturePort)).toBe(input);
    },
  );
});
