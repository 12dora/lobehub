// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { DISABLED_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import {
  clearManagedResourceReadinessForTest,
  hasManagedResourceReadinessProbeForTest,
} from '@/server/enterprise/services/managedResourceReadiness';

import {
  ensureSkillCatalogReadinessRegistered,
  resetSkillCatalogReadinessRegistrationForTest,
  resolveSkillCatalogRuntimeReadiness,
} from './runtimeReadiness';

const managedFlags = {
  ...DISABLED_ENTERPRISE_FEATURE_FLAGS,
  ENABLE_PLATFORM_MANAGED_SKILLS: true,
};
const checksum = 'a'.repeat(64);
const published = {
  checksum,
  description: 'Ready',
  displayName: 'Ready',
  distribution: 'default' as const,
  skillKey: 'ready.skill',
  source: 'uploaded' as const,
  version: '1.0.0',
};
const resolved = {
  ...published,
  allowBuiltinOverride: false,
  content: '# Ready',
  contentRef: null,
  manifest: {},
  resources: [],
  skillId: 'skill-1',
  versionId: 'version-1',
};

describe('Skill catalog runtime readiness', () => {
  it('registers the skills probe without performing eager I/O', () => {
    clearManagedResourceReadinessForTest();
    resetSkillCatalogReadinessRegistrationForTest();
    ensureSkillCatalogReadinessRegistered();
    expect(hasManagedResourceReadinessProbeForTest('skills')).toBe(true);
  });

  it('returns before DB or catalog I/O while the feature is disabled', async () => {
    const service = {
      getPublishedCatalog: vi.fn(),
      resolvePinnedForExecution: vi.fn(),
    };
    await expect(
      resolveSkillCatalogRuntimeReadiness({
        db: new Proxy({}, { get: () => expect.unreachable('must not read DB') }) as never,
        flags: DISABLED_ENTERPRISE_FEATURE_FLAGS,
        service,
      }),
    ).resolves.toBe(false);
    expect(service.getPublishedCatalog).not.toHaveBeenCalled();
  });

  it('accepts an empty catalog and requires exact checksum resolution for non-empty entries', async () => {
    const emptyService = {
      getPublishedCatalog: vi.fn().mockResolvedValue({ revision: 'empty', skills: [] }),
      resolvePinnedForExecution: vi.fn(),
    };
    await expect(
      resolveSkillCatalogRuntimeReadiness({
        db: {} as never,
        flags: managedFlags,
        service: emptyService,
      }),
    ).resolves.toBe(true);
    expect(emptyService.resolvePinnedForExecution).not.toHaveBeenCalled();

    const mismatchService = {
      getPublishedCatalog: vi.fn().mockResolvedValue({ revision: 'r1', skills: [published] }),
      resolvePinnedForExecution: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      resolveSkillCatalogRuntimeReadiness({
        db: {} as never,
        flags: managedFlags,
        service: mismatchService,
      }),
    ).resolves.toBe(false);
    expect(mismatchService.resolvePinnedForExecution).toHaveBeenCalledWith({
      checksum,
      skillKey: 'ready.skill',
      version: '1.0.0',
    });
  });

  it('rejects opaque execution content/resources without a trusted resolver', async () => {
    for (const opaque of [
      { ...resolved, contentRef: 'opaque:skill-content' },
      {
        ...resolved,
        resources: [
          {
            checksum,
            contentRef: 'opaque:resource',
            mediaType: 'text/plain',
            path: 'reference.txt',
            sizeBytes: 1,
          },
        ],
      },
    ]) {
      await expect(
        resolveSkillCatalogRuntimeReadiness({
          db: {} as never,
          flags: managedFlags,
          service: {
            getPublishedCatalog: vi.fn().mockResolvedValue({ revision: 'r1', skills: [published] }),
            resolvePinnedForExecution: vi.fn().mockResolvedValue(opaque),
          },
        }),
      ).resolves.toBe(false);
    }
  });

  it('accepts only fully inline exact immutable execution projections', async () => {
    await expect(
      resolveSkillCatalogRuntimeReadiness({
        db: {} as never,
        flags: managedFlags,
        service: {
          getPublishedCatalog: vi.fn().mockResolvedValue({ revision: 'r1', skills: [published] }),
          resolvePinnedForExecution: vi.fn().mockResolvedValue(resolved),
        },
      }),
    ).resolves.toBe(true);
  });

  it('uses the bounded revision readiness index instead of resolving 10,000 entries', async () => {
    const catalog = {
      revision: 'large-r1',
      skills: Array.from({ length: 10_000 }, (_, index) => ({
        ...published,
        checksum: index.toString(16).padStart(64, '0'),
        skillKey: `skill-${index}`,
      })),
    };
    const service = {
      getPublishedCatalog: vi.fn().mockResolvedValue(catalog),
      isPublishedCatalogExecutionReady: vi.fn().mockReturnValue(true),
      resolvePinnedForExecution: vi.fn(),
    };

    await expect(
      resolveSkillCatalogRuntimeReadiness({ db: {} as never, flags: managedFlags, service }),
    ).resolves.toBe(true);
    expect(service.isPublishedCatalogExecutionReady).toHaveBeenCalledWith(catalog);
    expect(service.resolvePinnedForExecution).not.toHaveBeenCalled();
  });
});
