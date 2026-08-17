import { describe, expect, it } from 'vitest';

import type { NetworkProxyConfigView } from '@/types/platform/networkProxy';

import { applyConfigPatch, patchOutlet, patchStaticProxy, toConfigUpdate } from './configUpdate';

const view = (overrides: Partial<NetworkProxyConfigView> = {}): NetworkProxyConfigView => ({
  bypassHosts: ['internal.example.com'],
  downloadViaStaticProxy: false,
  engineLogLevel: 'warning',
  masterEnabled: true,
  outlet: {
    kind: 'engine',
    latencyIntervalSec: 300,
    latencyTestUrl: 'https://www.gstatic.com/generate_204',
    manualNodeName: 'node-a',
    mode: 'manual',
    toleranceMs: 150,
  },
  ruleMode: 'simple',
  scopes: {
    features: {
      content_moderation: { enabled: false, onUnavailable: 'direct' },
      import_fetch: { enabled: false, onUnavailable: 'direct' },
      market: { enabled: true, onUnavailable: 'direct' },
      mcp: { enabled: false, onUnavailable: 'direct' },
      web_search: { enabled: false, onUnavailable: 'direct' },
    },
    providers: { openai: { enabled: true, onUnavailable: 'fail' } },
  },
  subscriptionUpdateViaOutlet: false,
  ...overrides,
});

describe('toConfigUpdate', () => {
  it('drops scopes (they are written through updateScopes) and keeps everything else', () => {
    const update = toConfigUpdate(view());
    expect('scopes' in update).toBe(false);
    expect(update.masterEnabled).toBe(true);
    expect(update.outlet.manualNodeName).toBe('node-a');
    expect(update.bypassHosts).toEqual(['internal.example.com']);
  });

  it('defaults the static-proxy password to keep so a save cannot silently drop it', () => {
    const update = toConfigUpdate(
      view({
        staticProxy: { hasPassword: true, port: 7890, server: 'p.example.com', type: 'http' },
      }),
    );
    expect(update.staticProxy).toEqual({
      password: { action: 'keep' },
      port: 7890,
      server: 'p.example.com',
      type: 'http',
    });
  });

  it('omits an absent username rather than sending an empty string', () => {
    const update = toConfigUpdate(
      view({ staticProxy: { hasPassword: false, port: 1080, server: 's', type: 'socks5' } }),
    );
    expect(update.staticProxy && 'username' in update.staticProxy).toBe(false);
  });

  it('sends null when no static proxy is configured', () => {
    expect(toConfigUpdate(view()).staticProxy).toBeNull();
  });

  it('copies arrays so a later edit cannot mutate the cached config', () => {
    const source = view();
    const update = toConfigUpdate(source);
    update.bypassHosts.push('other.example.com');
    expect(source.bypassHosts).toEqual(['internal.example.com']);
  });
});

describe('applyConfigPatch / patchOutlet / patchStaticProxy', () => {
  it('applies a top-level field without touching the rest', () => {
    const update = applyConfigPatch(view(), { masterEnabled: false });
    expect(update.masterEnabled).toBe(false);
    expect(update.ruleMode).toBe('simple');
  });

  it('merges into the outlet instead of replacing it', () => {
    const update = patchOutlet(view(), { mode: 'auto' });
    expect(update.outlet.mode).toBe('auto');
    expect(update.outlet.latencyTestUrl).toBe('https://www.gstatic.com/generate_204');
    expect(update.outlet.manualNodeName).toBe('node-a');
  });

  it('carries an explicit password instruction through', () => {
    const update = patchStaticProxy(view(), {
      password: { action: 'replace', value: 'secret' },
      port: 8080,
      server: 'new.example.com',
      type: 'https',
    });
    expect(update.staticProxy?.password).toEqual({ action: 'replace', value: 'secret' });
    expect(update.staticProxy?.server).toBe('new.example.com');
  });

  it('removes the static proxy when passed null', () => {
    expect(patchStaticProxy(view(), null).staticProxy).toBeNull();
  });
});
