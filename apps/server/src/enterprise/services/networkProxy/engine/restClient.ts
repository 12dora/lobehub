import { isRecord, pickString } from '@lobechat/utils/object';

import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';

export interface EngineRestClient {
  getGroup: (name: string) => Promise<{ all: string[]; now: string; type: string }>;
  getProviders: () => Promise<
    Record<
      string,
      {
        proxies: { alive?: boolean; history?: { delay: number }[]; name: string; type: string }[];
        updatedAt?: string;
      }
    >
  >;
  getProxies: () => Promise<
    Record<
      string,
      {
        alive?: boolean;
        all?: string[];
        history?: { delay: number }[];
        now?: string;
        type: string;
      }
    >
  >;
  groupDelay: (group: string, url: string, timeoutMs: number) => Promise<Record<string, number>>;
  providerUpdate: (name: string) => Promise<void>;
  proxyDelay: (name: string, url: string, timeoutMs: number) => Promise<number | null>;
  reloadConfig: (configPath: string) => Promise<void>;
  selectProxy: (group: string, name: string) => Promise<void>;
  version: () => Promise<{ version: string }>;
}

const encodePathSegment = (value: string): string => encodeURIComponent(value);

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const asHistory = (value: unknown): { delay: number }[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.delay !== 'number') return [];
    return [{ delay: item.delay }];
  });
};

export const createEngineRestClient = (opts: {
  controller: string;
  secret: string;
  timeoutMs?: number;
}): EngineRestClient => {
  const base = opts.controller.replace(/\/+$/u, '');
  const timeoutMs = opts.timeoutMs ?? NETWORK_PROXY_LIMITS.LATENCY_TEST_TIMEOUT_MS;

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        'Authorization': `Bearer ${opts.secret}`,
        'Content-Type': 'application/json',
      },
      method,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`engine REST ${method} ${path} failed (${response.status})`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`engine REST ${method} ${path} returned non-JSON`);
    }
  };

  return {
    getGroup: async (name) => {
      const raw = await request('GET', `/proxies/${encodePathSegment(name)}`);
      const record = isRecord(raw) ? raw : {};
      return {
        all: asStringArray(record.all),
        now: pickString(record.now) ?? '',
        type: pickString(record.type) ?? '',
      };
    },
    getProviders: async () => {
      const raw = await request('GET', '/providers/proxies');
      const wrapped =
        isRecord(raw) && isRecord(raw.providers) ? raw.providers : isRecord(raw) ? raw : {};
      const result: Awaited<ReturnType<EngineRestClient['getProviders']>> = {};
      for (const [name, value] of Object.entries(wrapped)) {
        if (!isRecord(value)) continue;
        const proxies = Array.isArray(value.proxies)
          ? value.proxies.flatMap((proxy) => {
              if (!isRecord(proxy) || typeof proxy.name !== 'string') return [];
              return [
                {
                  alive: typeof proxy.alive === 'boolean' ? proxy.alive : undefined,
                  history: asHistory(proxy.history),
                  name: proxy.name,
                  type: pickString(proxy.type) ?? '',
                },
              ];
            })
          : [];
        result[name] = {
          proxies,
          updatedAt: pickString(value.updatedAt),
        };
      }
      return result;
    },
    getProxies: async () => {
      const raw = await request('GET', '/proxies');
      const wrapped =
        isRecord(raw) && isRecord(raw.proxies) ? raw.proxies : isRecord(raw) ? raw : {};
      const result: Awaited<ReturnType<EngineRestClient['getProxies']>> = {};
      for (const [name, value] of Object.entries(wrapped)) {
        if (!isRecord(value)) continue;
        result[name] = {
          alive: typeof value.alive === 'boolean' ? value.alive : undefined,
          all: asStringArray(value.all),
          history: asHistory(value.history),
          now: pickString(value.now),
          type: pickString(value.type) ?? '',
        };
      }
      return result;
    },
    groupDelay: async (group, url, delayTimeoutMs) => {
      const query = new URLSearchParams({
        timeout: String(delayTimeoutMs),
        url,
      });
      const raw = await request(
        'GET',
        `/group/${encodePathSegment(group)}/delay?${query.toString()}`,
      );
      const record = isRecord(raw) ? raw : {};
      const result: Record<string, number> = {};
      for (const [name, value] of Object.entries(record)) {
        if (typeof value === 'number') result[name] = value;
      }
      return result;
    },
    providerUpdate: async (name) => {
      await request('PUT', `/providers/proxies/${encodePathSegment(name)}`);
    },
    proxyDelay: async (name, url, delayTimeoutMs) => {
      const query = new URLSearchParams({
        timeout: String(delayTimeoutMs),
        url,
      });
      const raw = await request(
        'GET',
        `/proxies/${encodePathSegment(name)}/delay?${query.toString()}`,
      );
      const delay = isRecord(raw) && typeof raw.delay === 'number' ? raw.delay : null;
      return delay && delay > 0 ? delay : null;
    },
    reloadConfig: async (configPath) => {
      await request('PUT', '/configs?force=true', { path: configPath });
    },
    selectProxy: async (group, name) => {
      await request('PUT', `/proxies/${encodePathSegment(group)}`, { name });
    },
    version: async () => {
      const raw = await request('GET', '/version');
      const version = isRecord(raw) ? pickString(raw.version) : null;
      if (!version) throw new Error('engine REST /version missing version');
      return { version };
    },
  };
};
