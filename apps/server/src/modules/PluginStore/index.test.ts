// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { PluginStore } from './index';

const baseURL = 'https://registry.npmmirror.com/@lobehub/plugins-index/v1/files/public';

describe('PluginStore', () => {
  it('should return the default index URL when no language is provided', () => {
    const pluginStore = new PluginStore();
    const url = pluginStore.getPluginIndexUrl();
    expect(url).toBe(`${baseURL}/index.en-US.json`);
  });

  it('should return the index URL for a supported language', () => {
    const pluginStore = new PluginStore();
    const url = pluginStore.getPluginIndexUrl('en-US');
    expect(url).toBe(`${baseURL}/index.en-US.json`);
  });

  it('should return the base URL if the provided language is not supported', () => {
    const pluginStore = new PluginStore();
    const url = pluginStore.getPluginIndexUrl('fr-FR');
    expect(url).toBe(`${baseURL}/index.fr-FR.json`);
  });

  it('rethrows fail-mode instead of returning an empty list', async () => {
    const fail = Object.assign(new Error('PLATFORM_NETWORK_PROXY_UNAVAILABLE'), {
      errorType: 'PLATFORM_NETWORK_PROXY_UNAVAILABLE',
      name: 'NetworkProxyUnavailableError',
    });
    const previous = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(fail) as typeof fetch;
    try {
      const pluginStore = new PluginStore();
      await expect(pluginStore.getPluginList()).rejects.toBe(fail);
    } finally {
      globalThis.fetch = previous;
    }
  });
});
