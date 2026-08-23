import { describe, expect, it } from 'vitest';

import type {
  ArtifactStatusView,
  InstanceStatusView,
  NetworkProxyConfigView,
  NetworkProxyStatusView,
} from '@/types/platform/networkProxy';
import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import type { NetworkProxyBannerInput } from './bannerState';
import { groupEngineInstances, resolveNetworkProxyBanners } from './bannerState';

const config = (patch: Partial<NetworkProxyConfigView> = {}): NetworkProxyConfigView =>
  ({ ...createDefaultNetworkProxyConfig(), ...patch }) as NetworkProxyConfigView;

const instance = (patch: Partial<InstanceStatusView> = {}): InstanceStatusView =>
  ({
    activeNode: null,
    aliveNodeCount: null,
    appliedRevision: 1,
    arch: 'arm64',
    artifacts: [],
    engineState: 'running',
    engineVersion: '1.0.0',
    fallbackCount: 0,
    healing: null,
    instanceId: 'i-1',
    isCurrent: true,
    lastHeartbeatAt: '2026-08-23T00:00:00.000Z',
    lastIssue: null,
    platform: 'linux',
    proxiedCount: 0,
    updatedAt: '2026-08-23T00:00:00.000Z',
    ...patch,
  }) as InstanceStatusView;

const issue = (code: string, detail: string | null = null) =>
  ({ at: '2026-08-23T00:00:00.000Z', code, detail }) as InstanceStatusView['lastIssue'];

const artifacts = (supported: boolean): ArtifactStatusView =>
  ({ engine: { platformKey: 'linux/arm64', supported, version: '1.0.0' } }) as ArtifactStatusView;

const status = (instances: InstanceStatusView[] = []): NetworkProxyStatusView =>
  ({ fallbackScopes: [], globalProxyActive: false, instances, revision: 1 }) as never;

const input = (patch: Partial<NetworkProxyBannerInput> = {}): NetworkProxyBannerInput => ({
  config: config(),
  conflictCount: 0,
  fallbackScopes: [],
  geodataState: 'ready',
  globalProxyActive: false,
  groups: groupEngineInstances([]),
  healingSeconds: 0,
  selfHealed: false,
  status: status(),
  ...patch,
});

const kinds = (patch: Partial<NetworkProxyBannerInput> = {}) =>
  resolveNetworkProxyBanners(input(patch)).map((state) => state.kind);

describe('groupEngineInstances', () => {
  it('does not treat a live or admin-stopped engine as broken just because it recorded an issue', () => {
    for (const engineState of ['running', 'degraded', 'stopped'] as const) {
      const groups = groupEngineInstances([
        instance({ engineState, lastIssue: issue('start_failed') }),
      ]);
      expect(groups.terminal).toHaveLength(0);
      expect(groups.healing).toHaveLength(0);
    }
  });

  it('splits missing rule data out of the breakages — it is a setup step, not an outage', () => {
    const groups = groupEngineInstances([
      instance({ engineState: 'not_installed', lastIssue: issue('geodata_missing') }),
    ]);
    expect(groups.geodataMissing).toBe(true);
    expect(groups.terminal).toHaveLength(0);
  });

  it('counts an errored instance with a scheduled retry as healing, others as terminal', () => {
    const groups = groupEngineInstances([
      instance({
        engineState: 'error',
        healing: { attempt: 2, nextAttemptAt: '2026-08-23T00:00:30.000Z' },
        instanceId: 'i-healing',
        lastIssue: issue('start_failed'),
      }),
      instance({ engineState: 'error', instanceId: 'i-dead', lastIssue: issue('start_failed') }),
    ]);
    expect(groups.healing.map((row) => row.instanceId)).toEqual(['i-healing']);
    expect(groups.terminal.map((row) => row.instanceId)).toEqual(['i-dead']);
  });
});

describe('resolveNetworkProxyBanners', () => {
  it('raises nothing when every query answered and the engine is healthy', () => {
    expect(kinds()).toEqual([]);
  });

  it('keeps the precedence when every condition holds at once', () => {
    const groups = groupEngineInstances([
      instance({
        engineState: 'error',
        healing: { attempt: 1, nextAttemptAt: '2026-08-23T00:00:30.000Z' },
        instanceId: 'i-healing',
        lastIssue: issue('start_failed'),
      }),
      instance({ engineState: 'error', instanceId: 'i-dead', lastIssue: issue('start_failed') }),
      instance({
        engineState: 'not_installed',
        instanceId: 'i-3',
        lastIssue: issue('geodata_missing'),
      }),
    ]);
    expect(
      kinds({
        artifacts: artifacts(false),
        artifactsStale: true,
        conflictCount: 2,
        fallbackScopes: ['provider:openai'],
        globalProxyActive: true,
        groups,
        selfHealed: true,
        statusStale: true,
      }),
    ).toEqual([
      'conflict',
      'globalProxy',
      'statusStale',
      'artifactsStale',
      'unsupported',
      'selfHealed',
      'engineIssue',
      'fallback',
      'geodata',
    ]);
  });

  it('reports a failed query as unknown, and only when nothing is cached', () => {
    expect(kinds({ status: undefined, statusError: new Error('boom') })).toEqual(['statusUnknown']);
    expect(kinds({ statusError: new Error('boom'), statusStale: true })).toEqual(['statusStale']);
    expect(kinds({ artifactsError: new Error('boom') })).toEqual(['artifactsUnknown']);
    expect(kinds({ artifacts: artifacts(true), artifactsError: new Error('boom') })).toEqual([]);
  });

  it('gives the engine exactly one banner, and terminal instances win over recovering ones', () => {
    const healingOnly = groupEngineInstances([
      instance({
        engineState: 'error',
        healing: { attempt: 1, nextAttemptAt: '2026-08-23T00:00:30.000Z' },
        lastIssue: issue('start_failed'),
      }),
    ]);
    const both = groupEngineInstances([
      instance({
        engineState: 'error',
        healing: { attempt: 1, nextAttemptAt: '2026-08-23T00:00:30.000Z' },
        instanceId: 'i-healing',
        lastIssue: issue('start_failed'),
      }),
      instance({ engineState: 'error', instanceId: 'i-dead', lastIssue: issue('port_conflict') }),
    ]);

    expect(kinds({ groups: healingOnly })).toEqual(['selfHealing']);
    expect(kinds({ groups: both })).toEqual(['engineIssue']);

    const [engineIssue] = resolveNetworkProxyBanners(input({ groups: both }));
    expect(engineIssue).toMatchObject({
      healingCount: 1,
      kind: 'engineIssue',
      terminalCount: 1,
    });
    // The banner names the terminal instance's reason, never the recovering one's.
    expect(engineIssue.kind === 'engineIssue' && engineIssue.issue?.code).toBe('port_conflict');
  });

  it('carries the countdown into the recovering banner', () => {
    const groups = groupEngineInstances([
      instance({
        engineState: 'error',
        healing: { attempt: 1, nextAttemptAt: '2026-08-23T00:00:30.000Z' },
        lastIssue: issue('start_failed'),
      }),
    ]);
    const [state] = resolveNetworkProxyBanners(input({ groups, healingSeconds: 17 }));
    expect(state).toMatchObject({ kind: 'selfHealing', seconds: 17 });
  });

  it('offers the rule-data install for smart routing, but never on an unreadable artifact query', () => {
    expect(kinds({ config: config({ ruleMode: 'smart' }), geodataState: 'missing' })).toEqual([
      'geodata',
    ]);
    // "unknown" is not evidence of an empty disk.
    expect(kinds({ config: config({ ruleMode: 'smart' }), geodataState: 'unknown' })).toEqual([]);
    expect(
      kinds({
        artifactsError: new Error('boom'),
        config: config({ ruleMode: 'smart' }),
        geodataState: 'missing',
      }),
    ).toEqual(['artifactsUnknown']);
  });
});
