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
            checksum: 'a'.repeat(64),
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
        selectedSkills: [{ identifier: 'approved.skill', name: 'Approved Skill' }],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ content: 'approved body', identifier: 'approved.skill' }),
    ]);
    expect(mockedResolvePlatformPinned).toHaveBeenCalledWith({
      checksum: 'a'.repeat(64),
      skillKey: 'approved.skill',
      version: '1.0.0',
    });
  });

  it('does not fall back to a personal Skill outside the published catalog', async () => {
    await expect(
      resolveSelectedSkillsWithContent({
        message: '',
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
        selectedSkills: [{ identifier: 'approved.skill', name: 'Approved Skill' }],
      }),
    ).rejects.toThrow('not found');
  });
});
