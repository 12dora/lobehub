// @vitest-environment node
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineRestClient } from './restClient';

const VERSION_FIXTURE = { meta: true, version: 'v1.19.30' };

const PROXIES_FIXTURE = {
  proxies: {
    'AIHUB-OUT': {
      alive: true,
      all: ['hk-01', 'jp-01'],
      history: [{ delay: 120, time: '2026-08-17T00:00:00.000Z' }],
      name: 'AIHUB-OUT',
      now: 'hk-01',
      type: 'URLTest',
    },
    'hk-01': {
      alive: true,
      history: [{ delay: 120, time: '2026-08-17T00:00:00.000Z' }],
      name: 'hk-01',
      type: 'Shadowsocks',
    },
    'jp-01': {
      alive: false,
      history: [{ delay: 0, time: '2026-08-17T00:00:00.000Z' }],
      name: 'jp-01',
      type: 'Trojan',
    },
  },
};

const PROVIDERS_FIXTURE = {
  providers: {
    sub_nps_aaa: {
      name: 'sub_nps_aaa',
      proxies: [
        {
          alive: true,
          history: [{ delay: 120, time: '2026-08-17T00:00:00.000Z' }],
          name: 'hk-01',
          type: 'Shadowsocks',
        },
      ],
      type: 'Proxy',
      updatedAt: '2026-08-17T00:00:00.000Z',
      vehicleType: 'File',
    },
  },
};

const GROUP_DELAY_FIXTURE = { 'hk-01': 118, 'jp-01': 0 };
const PROXY_DELAY_FIXTURE = { delay: 118 };

const seen: { auth?: string; body?: string; method: string; url: string }[] = [];

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk as Buffer));
  req.on('end', () => {
    seen.push({
      auth: req.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
      method: req.method ?? 'GET',
      url: req.url ?? '',
    });
    const url = req.url ?? '';
    res.setHeader('content-type', 'application/json');
    if (url === '/version') {
      res.end(JSON.stringify(VERSION_FIXTURE));
      return;
    }
    if (url === '/proxies') {
      res.end(JSON.stringify(PROXIES_FIXTURE));
      return;
    }
    if (url === '/proxies/AIHUB-OUT') {
      res.end(JSON.stringify(PROXIES_FIXTURE.proxies['AIHUB-OUT']));
      return;
    }
    if (url.startsWith('/proxies/AIHUB-OUT') && req.method === 'PUT') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (url.startsWith('/proxies/hk-01/delay')) {
      res.end(JSON.stringify(PROXY_DELAY_FIXTURE));
      return;
    }
    if (url.startsWith('/group/AIHUB-OUT/delay')) {
      res.end(JSON.stringify(GROUP_DELAY_FIXTURE));
      return;
    }
    if (url === '/providers/proxies') {
      res.end(JSON.stringify(PROVIDERS_FIXTURE));
      return;
    }
    if (url === '/providers/proxies/sub_nps_aaa' && req.method === 'PUT') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (url === '/configs?force=true' && req.method === 'PUT') {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'not found' }));
  });
});

let client: ReturnType<typeof createEngineRestClient>;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  client = createEngineRestClient({
    controller: `http://127.0.0.1:${port}`,
    secret: 'test-secret',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('createEngineRestClient (mihomo v1.19.30 fixtures)', () => {
  it('reads /version', async () => {
    await expect(client.version()).resolves.toEqual({ version: 'v1.19.30' });
  });

  it('unwraps GET /proxies and GET /proxies/{group}', async () => {
    const proxies = await client.getProxies();
    expect(proxies['AIHUB-OUT']).toMatchObject({
      alive: true,
      now: 'hk-01',
      type: 'URLTest',
    });
    const group = await client.getGroup('AIHUB-OUT');
    expect(group).toEqual({ all: ['hk-01', 'jp-01'], now: 'hk-01', type: 'URLTest' });
  });

  it('selects a node, tests delay, updates a provider and reloads config', async () => {
    await client.selectProxy('AIHUB-OUT', 'hk-01');
    await expect(
      client.proxyDelay('hk-01', 'https://www.gstatic.com/generate_204', 5000),
    ).resolves.toBe(118);
    await expect(
      client.groupDelay('AIHUB-OUT', 'https://www.gstatic.com/generate_204', 5000),
    ).resolves.toEqual(GROUP_DELAY_FIXTURE);
    const providers = await client.getProviders();
    expect(providers.sub_nps_aaa?.updatedAt).toBe('2026-08-17T00:00:00.000Z');
    expect(providers.sub_nps_aaa?.proxies[0]?.name).toBe('hk-01');
    await client.providerUpdate('sub_nps_aaa');
    await client.reloadConfig('/tmp/runtime/config.yaml');

    expect(seen.some((item) => item.auth === 'Bearer test-secret')).toBe(true);
    const reload = seen.find((item) => item.url === '/configs?force=true');
    expect(reload?.body).toBe(JSON.stringify({ path: '/tmp/runtime/config.yaml' }));
    const select = seen.find((item) => item.method === 'PUT' && item.url === '/proxies/AIHUB-OUT');
    expect(select?.body).toBe(JSON.stringify({ name: 'hk-01' }));
  });
});
