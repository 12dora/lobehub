import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    platform: {
      skills: {
        getPublishedCatalog: { query },
      },
    },
  },
}));

describe('platformSkillsService', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ revision: 'catalog-revision', skills: [] });
  });

  it('uses the read-only public catalog procedure', async () => {
    const { platformSkillsService } = await import('./platformSkills');
    await expect(platformSkillsService.getPublishedCatalog()).resolves.toEqual({
      revision: 'catalog-revision',
      skills: [],
    });
    expect(query).toHaveBeenCalledOnce();
  });
});
