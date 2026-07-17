import type { PlatformSkillOperationSnapshot } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentSkillService } from '@/services/skill';
import { getToolStoreState } from '@/store/tool';

import { resolveSelectedSkillsWithContent } from './skillPreload';

vi.mock('@/store/tool', () => ({ getToolStoreState: vi.fn() }));
vi.mock('@/services/skill', () => ({
  agentSkillService: { getById: vi.fn(), getByIdentifier: vi.fn(), resolvePlatformPinned: vi.fn() },
}));

const mockedState = vi.mocked(getToolStoreState);
const mockedResolvePlatformPinned = vi.mocked(agentSkillService.resolvePlatformPinned);
const checksumV1 = 'a'.repeat(64);
const checksumV2 = 'b'.repeat(64);
const operationSnapshot: PlatformSkillOperationSnapshot = {
  mandatorySkillIds: [],
  refs: [{ checksum: checksumV1, skillKey: 'approved.skill', version: '1.0.0' }],
  revision: 'catalog-1',
  skills: [
    {
      checksum: checksumV1,
      description: 'Approved',
      displayName: 'Approved Skill',
      distribution: 'optional',
      skillKey: 'approved.skill',
      source: 'uploaded',
      version: '1.0.0',
    },
  ],
};

describe('managed platform Skill preload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedState.mockReturnValue({
      agentSkillDetailMap: {},
      agentSkills: [],
      builtinSkills: [],
      platformSkillCatalog: {
        revision: 'catalog-1',
        skills: [
          {
            checksum: checksumV1,
            description: 'Approved',
            displayName: 'Approved Skill',
            distribution: 'optional',
            skillKey: 'approved.skill',
            source: 'uploaded',
            version: '1.0.0',
          },
        ],
      },
      platformSkillRuntimeStatus: 'ready',
    } as never);
  });

  it('loads selected content through the server-adapted published resolver', async () => {
    mockedResolvePlatformPinned.mockResolvedValue({
      checksum: 'a'.repeat(64),
      content: 'approved body',
      description: 'Approved',
      identifier: 'approved.skill',
      name: 'Approved Skill',
      resources: [],
      version: '1.0.0',
    } as never);

    await expect(
      resolveSelectedSkillsWithContent({
        message: '',
        platformSkillSnapshot: operationSnapshot,
        selectedSkills: [{ identifier: 'approved.skill', name: 'Approved Skill' }],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ content: 'approved body', identifier: 'approved.skill' }),
    ]);
    expect(mockedResolvePlatformPinned).toHaveBeenCalledWith(
      {
        checksum: checksumV1,
        skillKey: 'approved.skill',
        version: '1.0.0',
      },
      operationSnapshot,
    );
  });

  it('does not fall back to a personal Skill outside the published catalog', async () => {
    await expect(
      resolveSelectedSkillsWithContent({
        message: '',
        platformSkillSnapshot: operationSnapshot,
        selectedSkills: [{ identifier: 'personal.skill', name: 'Personal' }],
      }),
    ).resolves.toEqual([]);
    expect(mockedResolvePlatformPinned).not.toHaveBeenCalled();
  });

  it('fails closed when published content is missing', async () => {
    mockedResolvePlatformPinned.mockRejectedValue(new Error('not found'));

    await expect(
      resolveSelectedSkillsWithContent({
        message: '',
        platformSkillSnapshot: operationSnapshot,
        selectedSkills: [{ identifier: 'approved.skill', name: 'Approved Skill' }],
      }),
    ).rejects.toThrow('not found');
  });

  it('resolves the captured version when the moving catalog changes before preload', async () => {
    mockedState.mockReturnValue({
      agentSkillDetailMap: {},
      agentSkills: [],
      builtinSkills: [],
      platformSkillCatalog: {
        revision: 'catalog-2',
        skills: [
          {
            ...operationSnapshot.skills![0],
            checksum: checksumV2,
            version: '2.0.0',
          },
        ],
      },
      platformSkillRuntimeStatus: 'ready',
    } as never);
    mockedResolvePlatformPinned.mockResolvedValue({
      checksum: checksumV1,
      content: 'immutable v1 body',
      description: 'Approved',
      identifier: 'approved.skill',
      name: 'Approved Skill',
      resources: [],
      version: '1.0.0',
    } as never);

    await expect(
      resolveSelectedSkillsWithContent({
        message: '',
        platformSkillSnapshot: operationSnapshot,
        selectedSkills: [{ identifier: 'approved.skill', name: 'Approved Skill' }],
      }),
    ).resolves.toEqual([expect.objectContaining({ content: 'immutable v1 body' })]);
    expect(mockedResolvePlatformPinned).toHaveBeenCalledWith(
      operationSnapshot.refs[0],
      operationSnapshot,
    );
  });

  it('does not load disabled or optional Skills absent from the operation snapshot', async () => {
    mockedState.mockReturnValue({
      agentSkillDetailMap: {},
      agentSkills: [],
      builtinSkills: [],
      platformSkillCatalog: null,
      platformSkillRuntimeStatus: 'unmanaged',
    } as never);

    await expect(
      resolveSelectedSkillsWithContent({
        message: '<skill identifier="disabled.skill" />',
        platformSkillSnapshot: operationSnapshot,
        selectedSkills: [{ identifier: 'optional.skill', name: 'Optional' }],
      }),
    ).resolves.toEqual([]);
    expect(mockedResolvePlatformPinned).not.toHaveBeenCalled();
  });
});
