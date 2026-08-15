import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatGPTWebClient } from './client';
import { OAI_CLIENT_BUILD_NUMBER, OAI_CLIENT_VERSION } from './constants';
import { ChatGPTWebError } from './errors';
import * as pow from './pow';
import { parseClientBuildInfo, resolvePowResources, solveSentinelChallenges } from './sentinel';

const resources = { dataBuild: '', scriptSources: ['https://chatgpt.com/x.js'] };

const prepareWithPow = {
  prepare_token: 'prep',
  proofofwork: { difficulty: 'ffff', required: true, seed: 'seed' },
};

describe('resolvePowResources', () => {
  it('falls back to the default sdk script when there is no html', () => {
    expect(resolvePowResources(undefined).scriptSources).toEqual([
      'https://chatgpt.com/backend-api/sentinel/sdk.js',
    ]);
  });
});

describe('parseClientBuildInfo', () => {
  // shape of the live bootstrap HTML (2026-08-15)
  const html =
    '<!DOCTYPE html><html lang="en" data-build="prod-ee87f098e2f639d6379472eb197d55ab7018cdff">' +
    '<script>self.__next_f.push([1,"{\\"build_number\\":9395725.0,\\"x\\":1}"])</script></html>';

  it('reads the live client version and build number', () => {
    expect(parseClientBuildInfo(html)).toEqual({
      buildNumber: '9395725',
      clientVersion: 'prod-ee87f098e2f639d6379472eb197d55ab7018cdff',
    });
  });

  it('returns nothing it cannot find, so the caller keeps its constants', () => {
    expect(parseClientBuildInfo(undefined)).toEqual({});
    expect(parseClientBuildInfo('<html>Just a moment…</html>')).toEqual({
      buildNumber: undefined,
      clientVersion: undefined,
    });
  });
});

describe('getChatRequirements build markers', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });

  it('advertises the build markers scraped from the bootstrap html', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('<html data-build="prod-livebuild"><b>build_number\\":424242.0</b></html>', {
          headers: { 'content-type': 'text/html' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(json({ prepare_token: 'prep' }))
      .mockResolvedValueOnce(json({ so_token: 'so', token: 'requirements' }));

    const client = new ChatGPTWebClient({
      accessToken: 'access-token',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.getChatRequirements();

    const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(headers['OAI-Client-Version']).toBe('prod-livebuild');
    expect(headers['OAI-Client-Build-Number']).toBe('424242');
  });

  it('falls back to the pinned constants when the bootstrap is blocked', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 403 }))
      .mockResolvedValueOnce(json({ prepare_token: 'prep' }))
      .mockResolvedValueOnce(json({ so_token: 'so', token: 'requirements' }));

    const client = new ChatGPTWebClient({
      accessToken: 'access-token',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.getChatRequirements();

    const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(headers['OAI-Client-Version']).toBe(OAI_CLIENT_VERSION);
    expect(headers['OAI-Client-Build-Number']).toBe(OAI_CLIENT_BUILD_NUMBER);
  });
});

describe('solveSentinelChallenges', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('retries a proof-of-work cap exactly once, with a fresh config', async () => {
    const configs: unknown[] = [];
    const solve = vi
      .spyOn(pow, 'solveProofToken')
      .mockImplementationOnce(async ({ config }) => {
        configs.push(config);
        throw new ChatGPTWebError('pow', 'failed to solve');
      })
      .mockImplementationOnce(async ({ config }) => {
        configs.push(config);
        return 'gAAAAABproof';
      });

    const result = await solveSentinelChallenges({
      prepare: prepareWithPow,
      requirementsToken: 'p',
      resources,
      userAgent: 'UA',
    });

    expect(result.proofToken).toBe('gAAAAABproof');
    expect(solve).toHaveBeenCalledTimes(2);
    // the retry must not re-use the exhausted fingerprint
    expect(configs[0]).not.toEqual(configs[1]);
  });

  it('gives up after the second proof-of-work failure', async () => {
    vi.spyOn(pow, 'solveProofToken').mockRejectedValue(
      new ChatGPTWebError('pow', 'failed to solve'),
    );

    await expect(
      solveSentinelChallenges({
        prepare: prepareWithPow,
        requirementsToken: 'p',
        resources,
        userAgent: 'UA',
      }),
    ).rejects.toMatchObject({ kind: 'pow' });
    expect(pow.solveProofToken).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-pow failure', async () => {
    vi.spyOn(pow, 'solveProofToken').mockRejectedValue(new ChatGPTWebError('network', 'down'));

    await expect(
      solveSentinelChallenges({
        prepare: prepareWithPow,
        requirementsToken: 'p',
        resources,
        userAgent: 'UA',
      }),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(pow.solveProofToken).toHaveBeenCalledTimes(1);
  });

  it('honours a caller abort instead of retrying', async () => {
    const controller = new AbortController();
    vi.spyOn(pow, 'solveProofToken').mockImplementation(async () => {
      controller.abort();
      throw new ChatGPTWebError('pow', 'failed to solve');
    });

    await expect(
      solveSentinelChallenges({
        prepare: prepareWithPow,
        requirementsToken: 'p',
        resources,
        signal: controller.signal,
        userAgent: 'UA',
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(pow.solveProofToken).toHaveBeenCalledTimes(1);
  });

  it('refuses an Arkose challenge outright', async () => {
    await expect(
      solveSentinelChallenges({
        prepare: { arkose: { required: true } },
        requirementsToken: 'p',
        resources,
        userAgent: 'UA',
      }),
    ).rejects.toMatchObject({ kind: 'arkose' });
  });
});

describe('getChatRequirements Cloudflare retry', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });

  const challenge = () =>
    new Response('<!DOCTYPE html><html>Just a moment…</html>', {
      headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
      status: 403,
    });

  it('retries the sentinel prepare once when Cloudflare blocks it', async () => {
    const fetchMock = vi
      .fn()
      // bootstrap
      .mockResolvedValueOnce(challenge())
      // prepare: blocked, then fine
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(json({ prepare_token: 'prep' }))
      // finalize
      .mockResolvedValueOnce(json({ so_token: 'so', token: 'requirements' }));

    const client = new ChatGPTWebClient({
      accessToken: 'access-token',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.getChatRequirements()).resolves.toMatchObject({ token: 'requirements' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('gives up after a second Cloudflare block on finalize', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(json({ prepare_token: 'prep' }))
      .mockResolvedValue(challenge());

    const client = new ChatGPTWebClient({
      accessToken: 'access-token',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.getChatRequirements()).rejects.toMatchObject({ kind: 'cloudflare' });
  });
});
