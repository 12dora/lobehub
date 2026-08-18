// @vitest-environment node
import debug from 'debug';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DISABLED_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import { platformAgents, platformAgentVersions } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  clearManagedResourceReadinessForTest,
  hasManagedResourceReadinessProbeForTest,
} from '../managedResourceReadiness';
import * as moduleSettings from '../moduleSettings';
import {
  ensureAgentCatalogReadinessRegistered,
  resetAgentCatalogReadinessRegistrationForTest,
  resolveAgentCatalogRuntimeReadiness,
} from './runtimeReadiness';

const AGENT_READINESS_DEBUG_NS = 'lobe-server:agent-catalog-readiness';

// Enable the namespace before the SUT's `debug(...)` instance is created.
vi.hoisted(() => {
  const ns = 'lobe-server:agent-catalog-readiness';
  process.env.DEBUG = process.env.DEBUG ? `${process.env.DEBUG},${ns}` : ns;
});

const db: LobeChatDatabase = await getTestDB();
const managedFlags = {
  ...DISABLED_ENTERPRISE_FEATURE_FLAGS,
  ENABLE_PLATFORM_MANAGED_AGENTS: true,
};
const CHECKSUM = 'a'.repeat(64);

const cleanup = () =>
  db.execute(sql`
    TRUNCATE TABLE
      ${platformAgentVersions},
      ${platformAgents}
    RESTART IDENTITY CASCADE
  `);

const seedDraftAgent = async (id: string) => {
  await db.insert(platformAgents).values({
    agentKey: id,
    id,
    migrationRequired: false,
    status: 'draft',
    title: id,
  });
};

const seedPublishedAgent = async (id: string) => {
  await seedDraftAgent(id);
  const [version] = await db
    .insert(platformAgentVersions)
    .values({
      agentId: id,
      checksum: CHECKSUM,
      config: {
        displayName: id,
        modelParameters: {},
        openingQuestions: [],
        systemRole: 'help',
        tags: [],
      },
      dependencySnapshot: {
        connectors: [],
        model: {
          modelKey: 'chat',
          providerChecksum: 'b'.repeat(64),
          providerKey: 'provider',
          providerRevision: 1,
        },
        skills: [],
      },
      id: `${id}-v1`,
      version: '1.0.0',
    })
    .returning();
  await db
    .update(platformAgents)
    .set({
      currentVersionId: version.id,
      publishedAt: new Date(),
      revision: 1,
      status: 'published',
    })
    .where(eq(platformAgents.id, id));
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
  debug.enable(AGENT_READINESS_DEBUG_NS);
  const writes = vi.fn();
  const sink = (...args: unknown[]) => {
    writes(...args);
  };
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    writes(chunk);
    return true;
  }) as typeof process.stderr.write);
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
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleLog.mockRestore();
    consoleInfo.mockRestore();
    consoleDebug.mockRestore();
    debug.disable();
    if (previousNamespaces) debug.enable(previousNamespaces);
  }
};

beforeEach(cleanup);
afterEach(cleanup);

describe('Agent catalog runtime readiness', () => {
  it('registers the agents probe without performing eager I/O', () => {
    clearManagedResourceReadinessForTest();
    resetAgentCatalogReadinessRegistrationForTest();
    ensureAgentCatalogReadinessRegistered();
    expect(hasManagedResourceReadinessProbeForTest('agents')).toBe(true);
  });

  it('is exactly false while the managed runtime flag is disabled without reading DB', async () => {
    const failOnRead = new Proxy(
      {},
      {
        get: () => {
          throw new Error('readiness must not read DB while disabled');
        },
      },
    ) as LobeChatDatabase;
    await expect(
      resolveAgentCatalogRuntimeReadiness({
        db: failOnRead,
        flags: DISABLED_ENTERPRISE_FEATURE_FLAGS,
      }),
    ).resolves.toBe(false);
  });

  it('is false when no published platform agent identity exists', async () => {
    await seedDraftAgent('draft-only');
    await expect(resolveAgentCatalogRuntimeReadiness({ db, flags: managedFlags })).resolves.toBe(
      false,
    );
  });

  it('is true when at least one published platform agent identity exists', async () => {
    await seedPublishedAgent('published-agent');
    await expect(resolveAgentCatalogRuntimeReadiness({ db, flags: managedFlags })).resolves.toBe(
      true,
    );
  });

  it('swallows identity-list failures as unready without logging the error message', async () => {
    const marker = 'READINESS_SECRET_MARKER_agent-list';
    await withLogSpies(async (logged) => {
      await expect(
        resolveAgentCatalogRuntimeReadiness({
          db,
          flags: managedFlags,
          repository: {
            listIdentities: async () => {
              throw new Error(marker);
            },
          },
        }),
      ).resolves.toBe(false);
      expect(logged()).not.toContain(marker);
    });
  });

  it('treats a rejected module-gate as unready without logging the error message', async () => {
    const marker = 'READINESS_SECRET_MARKER_agent-module-reject';
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const gate = vi.spyOn(moduleSettings, 'isModuleEnabled').mockRejectedValue(new Error(marker));
    await withLogSpies(async (logged) => {
      await expect(resolveAgentCatalogRuntimeReadiness({ db })).resolves.toBe(false);
      expect(logged()).not.toContain(marker);
    });
    gate.mockRestore();
    vi.unstubAllEnvs();
  });

  it('treats a synchronous module-gate throw as unready without logging the error message', async () => {
    const marker = 'READINESS_SECRET_MARKER_agent-module-throw';
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const gate = vi.spyOn(moduleSettings, 'isModuleEnabled').mockImplementation(() => {
      throw new Error(marker);
    });
    await withLogSpies(async (logged) => {
      await expect(resolveAgentCatalogRuntimeReadiness({ db })).resolves.toBe(false);
      expect(logged()).not.toContain(marker);
    });
    gate.mockRestore();
    vi.unstubAllEnvs();
  });
});
