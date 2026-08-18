// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import debug from 'debug';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MANAGED_RESOURCE_KINDS } from '@/const/platform/managedResources';

import type { ManagedResourceReadinessProbe } from './managedResourceReadiness';

const READINESS_PROBES_GLOBAL_KEY = Symbol.for('__lobe_managed_resource_readiness__');
const READINESS_REGISTER_GLOBAL_KEY = Symbol.for('__lobe_managed_resource_readiness_register__');
const here = path.dirname(fileURLToPath(import.meta.url));

const RUNTIME_MOCK_SPECIFIERS = [
  './aiCatalog/runtimeReadiness',
  './connectorCatalog/runtimeReadiness',
  './skillCatalog/runtimeReadiness',
  './agentCatalog/runtimeReadiness',
] as const;

const resetProcessSlots = (): void => {
  const globalSlots = globalThis as Record<symbol, unknown>;
  delete globalSlots[READINESS_PROBES_GLOBAL_KEY];
  delete globalSlots[READINESS_REGISTER_GLOBAL_KEY];
};

const stringifyLogArg = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (value instanceof Error) return `${value.name}\n${value.message}\n${value.stack ?? ''}`;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

const withLogSpies = async (run: (logged: () => string) => Promise<void>) => {
  const previousNamespaces = debug.disable();
  debug.enable('*');
  const writes = vi.fn();
  const sink = (...args: unknown[]) => {
    writes(...args);
  };
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    writes(chunk);
    return true;
  }) as typeof process.stderr.write);
  const debugLog = vi.spyOn(debug, 'log').mockImplementation(sink);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(sink);
  const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(sink);
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(sink);
  const consoleInfo = vi.spyOn(console, 'info').mockImplementation(sink);
  const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(sink);
  try {
    await run(() =>
      writes.mock.calls.map((args) => args.map(stringifyLogArg).join(' ')).join('\n'),
    );
  } finally {
    stderrWrite.mockRestore();
    debugLog.mockRestore();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleLog.mockRestore();
    consoleInfo.mockRestore();
    consoleDebug.mockRestore();
    debug.disable();
    if (previousNamespaces) debug.enable(previousNamespaces);
  }
};

describe('managedResourceReadiness', () => {
  beforeEach(() => {
    resetProcessSlots();
    vi.resetModules();
    vi.doUnmock('../bootstrap/readinessProbes');
    for (const specifier of RUNTIME_MOCK_SPECIFIERS) vi.doUnmock(specifier);
  });

  afterEach(() => {
    resetProcessSlots();
    vi.resetModules();
    vi.doUnmock('../bootstrap/readinessProbes');
    for (const specifier of RUNTIME_MOCK_SPECIFIERS) vi.doUnmock(specifier);
    vi.restoreAllMocks();
  });

  it('does not statically import catalog runtimeReadiness (import-time registration)', () => {
    const source = readFileSync(path.join(here, 'managedResourceReadiness.ts'), 'utf8');
    const probesSource = readFileSync(path.join(here, '../bootstrap/readinessProbes.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"][^'"]*runtimeReadiness['"]/);
    expect(source).not.toMatch(/ensure\w+ReadinessRegistered\s*\(/);
    expect(probesSource).not.toMatch(/^import .*runtimeReadiness/m);
  });

  it('does not register probes when readinessProbes is imported', async () => {
    const { hasManagedResourceReadinessProbeForTest } = await import('./managedResourceReadiness');
    await import('../bootstrap/readinessProbes');
    for (const kind of MANAGED_RESOURCE_KINDS) {
      expect(hasManagedResourceReadinessProbeForTest(kind)).toBe(false);
    }
  });

  it('makes probes registered on one module copy visible to a fresh copy', async () => {
    const first = await import('./managedResourceReadiness');
    for (const kind of MANAGED_RESOURCE_KINDS) {
      first.registerManagedResourceReadiness(kind, () => kind === 'skills');
    }

    vi.resetModules();

    const second = await import('./managedResourceReadiness');
    expect(second.hasManagedResourceReadinessProbeForTest('skills')).toBe(true);
    expect(second.hasManagedResourceReadinessProbeForTest('aiProviders')).toBe(true);

    const readiness = await second.resolveManagedResourceReadiness();
    expect(readiness).toEqual({
      agents: false,
      aiModels: false,
      aiProviders: false,
      connectors: false,
      skills: true,
    });
  });

  it('shares one unresolved ensure across module copies', async () => {
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ensure = vi.fn(() =>
      deferred.then(async () => {
        const { registerManagedResourceReadiness } = await import('./managedResourceReadiness');
        for (const kind of MANAGED_RESOURCE_KINDS) {
          registerManagedResourceReadiness(kind, () => kind === 'skills');
        }
      }),
    );
    vi.doMock('../bootstrap/readinessProbes', () => ({
      ensureManagedResourceReadinessProbes: ensure,
    }));

    const first = await import('./managedResourceReadiness');
    const pendingFirst = first.resolveManagedResourceReadiness();
    await vi.waitFor(() => {
      expect(ensure).toHaveBeenCalledTimes(1);
    });

    vi.resetModules();
    vi.doMock('../bootstrap/readinessProbes', () => ({
      ensureManagedResourceReadinessProbes: ensure,
    }));

    const second = await import('./managedResourceReadiness');
    const pendingSecond = second.resolveManagedResourceReadiness();
    await Promise.resolve();
    expect(ensure).toHaveBeenCalledTimes(1);

    release();
    const [firstResult, secondResult] = await Promise.all([pendingFirst, pendingSecond]);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(firstResult.skills).toBe(true);
    expect(secondResult.skills).toBe(true);
    expect(firstResult.aiProviders).toBe(false);
  });

  it('invokes lazy ensure once when probes are missing and reflects the registered probe', async () => {
    const ensure = vi.fn(async () => {
      const { registerManagedResourceReadiness } = await import('./managedResourceReadiness');
      for (const kind of MANAGED_RESOURCE_KINDS) {
        registerManagedResourceReadiness(kind, () => kind === 'skills');
      }
    });
    vi.doMock('../bootstrap/readinessProbes', () => ({
      ensureManagedResourceReadinessProbes: ensure,
    }));

    const { hasManagedResourceReadinessProbeForTest, resolveManagedResourceReadiness } =
      await import('./managedResourceReadiness');

    const [first, second] = await Promise.all([
      resolveManagedResourceReadiness(),
      resolveManagedResourceReadiness(),
    ]);
    const third = await resolveManagedResourceReadiness();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(hasManagedResourceReadinessProbeForTest('skills')).toBe(true);
    expect(first.skills).toBe(true);
    expect(second.skills).toBe(true);
    expect(third.skills).toBe(true);
    expect(first.aiProviders).toBe(false);
  });

  it('resolves every kind from the real aggregator when catalog ensure* register stubs', async () => {
    const registry: {
      register: (
        resource: (typeof MANAGED_RESOURCE_KINDS)[number],
        probe: ManagedResourceReadinessProbe,
      ) => void;
    } = {
      register: () => {
        throw new Error('register not wired');
      },
    };
    const ensureAi = vi.fn(() => {
      registry.register('aiProviders', () => true);
      registry.register('aiModels', () => true);
    });
    const ensureConnectors = vi.fn(() => {
      registry.register('connectors', () => true);
    });
    const ensureSkills = vi.fn(() => {
      registry.register('skills', () => true);
    });
    const ensureAgents = vi.fn(() => {
      registry.register('agents', () => true);
    });

    vi.doMock('./aiCatalog/runtimeReadiness', () => ({
      ensureAiCatalogReadinessRegistered: ensureAi,
    }));
    vi.doMock('./connectorCatalog/runtimeReadiness', () => ({
      ensureConnectorCatalogReadinessRegistered: ensureConnectors,
    }));
    vi.doMock('./skillCatalog/runtimeReadiness', () => ({
      ensureSkillCatalogReadinessRegistered: ensureSkills,
    }));
    vi.doMock('./agentCatalog/runtimeReadiness', () => ({
      ensureAgentCatalogReadinessRegistered: ensureAgents,
    }));

    const { registerManagedResourceReadiness, resolveManagedResourceReadiness } =
      await import('./managedResourceReadiness');
    registry.register = registerManagedResourceReadiness;

    const { ensureManagedResourceReadinessProbes } = await import('../bootstrap/readinessProbes');
    await ensureManagedResourceReadinessProbes();

    expect(ensureAi).toHaveBeenCalledTimes(1);
    expect(ensureConnectors).toHaveBeenCalledTimes(1);
    expect(ensureSkills).toHaveBeenCalledTimes(1);
    expect(ensureAgents).toHaveBeenCalledTimes(1);

    await expect(resolveManagedResourceReadiness()).resolves.toEqual({
      agents: true,
      aiModels: true,
      aiProviders: true,
      connectors: true,
      skills: true,
    });
    await ensureManagedResourceReadinessProbes();
    expect(ensureAi).toHaveBeenCalledTimes(1);
  });

  it('returns all-false when probe registration import throws, hides the marker, and retries', async () => {
    const marker = 'READINESS_ENSURE_MARKER_import-failed';
    vi.doMock('../bootstrap/readinessProbes', () => {
      throw new Error(marker);
    });

    const { resolveManagedResourceReadiness } = await import('./managedResourceReadiness');
    const expected = {
      agents: false,
      aiModels: false,
      aiProviders: false,
      connectors: false,
      skills: false,
    };

    await withLogSpies(async (logged) => {
      await expect(resolveManagedResourceReadiness()).resolves.toEqual(expected);
      await expect(resolveManagedResourceReadiness()).resolves.toEqual(expected);
      const output = logged();
      expect(output).not.toContain(marker);
      expect(output.match(/probe registration failed/g)).toHaveLength(2);
    });
  });

  it('keeps test helpers on the shared registry', async () => {
    const {
      clearManagedResourceReadinessForTest,
      hasManagedResourceReadinessProbeForTest,
      registerManagedResourceReadiness,
    } = await import('./managedResourceReadiness');

    registerManagedResourceReadiness('agents', () => true);
    expect(hasManagedResourceReadinessProbeForTest('agents')).toBe(true);

    clearManagedResourceReadinessForTest();
    expect(hasManagedResourceReadinessProbeForTest('agents')).toBe(false);
  });
});
