import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminSkillsService } from './adminSkills';

const mocks = vi.hoisted(() => ({
  createVersion: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      skills: {
        createVersion: { mutate: mocks.createVersion },
        get: { query: mocks.get },
        list: { query: mocks.list },
        publish: { mutate: mocks.publish },
      },
    },
  },
}));

describe('M08 admin Skills client service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses query methods for list/detail reads with the complete server filter input', async () => {
    const input = {
      distribution: 'mandatory' as const,
      enabled: false,
      limit: 50,
      query: 'server search',
      source: 'uploaded' as const,
      status: 'published' as const,
    };
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });
    mocks.get.mockResolvedValue({ draft: { id: 'skill-1' } });

    await adminSkillsService.list(input);
    await adminSkillsService.get({ id: 'skill-1' });

    expect(mocks.list).toHaveBeenCalledWith(input);
    expect(mocks.get).toHaveBeenCalledWith({ id: 'skill-1' });
  });

  it('sends version and publish writes through mutate without a client checksum', async () => {
    const versionInput = {
      content: '# Safe Skill',
      contentRef: null,
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 3,
      manifest: {
        description: 'Safe Skill',
        displayName: 'Safe Skill',
        localizedDescriptions: {},
        localizedDisplayNames: {},
        permissions: {
          filesystem: 'none' as const,
          network: { allowedHosts: [], enabled: false },
          tools: { allow: [] },
        },
        skillDependencies: [],
        toolDependencies: [],
      },
      reason: 'reviewed immutable version',
      resources: [],
      skillId: 'skill-1',
      version: '1.0.0',
    };
    mocks.createVersion.mockResolvedValue({ id: 'version-1' });
    mocks.publish.mockResolvedValue({ status: 'published' });

    await adminSkillsService.createVersion(versionInput);
    await adminSkillsService.publish({
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 3,
      id: 'skill-1',
      reason: 'publish reviewed version',
      versionId: 'version-1',
    });

    expect(mocks.createVersion).toHaveBeenCalledWith(versionInput);
    expect(mocks.createVersion.mock.calls[0]?.[0]).not.toHaveProperty('checksum');
    expect(mocks.publish).toHaveBeenCalledOnce();
  });
});
