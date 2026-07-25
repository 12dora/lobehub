import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentSkillService } from '@/services/skill';
import { getToolStoreState } from '@/store/tool';

import { PLATFORM_SKILL_RESOLVE_CONCURRENCY, resolveClientSkills } from './skillEngineering';

vi.mock('@/store/tool', () => ({
  getToolStoreState: vi.fn(),
}));

vi.mock('@/services/skill', () => ({
  agentSkillService: {
    getById: vi.fn(),
    resolvePlatformPinned: vi.fn(),
  },
}));

// Keep all skills available in the test environment.
vi.mock('@/helpers/toolAvailability', () => ({
  isBuiltinSkillAvailableInCurrentEnv: () => true,
}));

const mockedGetToolStoreState = vi.mocked(getToolStoreState);
const mockedGetById = vi.mocked(agentSkillService.getById);
const mockedResolvePlatformPinned = vi.mocked(agentSkillService.resolvePlatformPinned);

const setToolState = (state: any) => {
  mockedGetToolStoreState.mockReturnValue({
    agentSkillDetailMap: {},
    agentSkills: [],
    builtinSkills: [],
    platformSkillCatalog: null,
    platformSkillRuntimeStatus: 'unmanaged',
    ...state,
  } as any);
};

const findSkill = (
  skills: { activated?: boolean; content?: string; identifier: string }[],
  identifier: string,
) => skills.find((s) => s.identifier === identifier);

describe('resolveClientSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries builtin skill content so pinned builtin skills can be injected', async () => {
    setToolState({
      builtinSkills: [
        {
          content: '<artifacts_guide>build UI</artifacts_guide>',
          description: 'Generate interactive UI',
          identifier: 'artifacts',
          name: 'Artifacts',
          source: 'builtin',
        },
      ],
    });

    const result = await resolveClientSkills(['artifacts']);

    expect(result.enabledPluginIds).toEqual(['artifacts']);
    // activated must be set so SkillContextProvider injects content directly
    // (the MessagesEngine path consumes these metas without running SkillResolver).
    expect(findSkill(result.skills, 'artifacts')).toMatchObject({
      activated: true,
      content: '<artifacts_guide>build UI</artifacts_guide>',
      identifier: 'artifacts',
    });
  });

  it('fetches DB skill content for pinned skills', async () => {
    setToolState({
      agentSkills: [
        { description: 'A user skill', id: 'db-1', identifier: 'my-skill', name: 'My Skill' },
      ],
    });
    mockedGetById.mockResolvedValue({
      content: 'full skill body',
      id: 'db-1',
      identifier: 'my-skill',
      name: 'My Skill',
    } as any);

    const result = await resolveClientSkills(['my-skill']);

    expect(mockedGetById).toHaveBeenCalledWith('db-1');
    expect(findSkill(result.skills, 'my-skill')).toMatchObject({
      activated: true,
      content: 'full skill body',
      identifier: 'my-skill',
    });
  });

  it('appends the resource tree to pinned DB skill content', async () => {
    setToolState({
      agentSkills: [{ description: '', id: 'db-1', identifier: 'my-skill', name: 'My Skill' }],
    });
    mockedGetById.mockResolvedValue({
      content: 'body',
      id: 'db-1',
      identifier: 'my-skill',
      name: 'My Skill',
      resources: { 'kb/readme.md': { fileHash: 'h', size: 1 } },
    } as any);

    const result = await resolveClientSkills(['my-skill']);

    const skill = findSkill(result.skills, 'my-skill');
    expect(skill?.content).toContain('body');
    // resourcesTreePrompt output references the resource tree
    expect(skill?.content).toContain('Available Resources');
    expect(skill?.content).toContain('readme.md');
  });

  it('does NOT fetch content for non-pinned DB skills (auto mode bulk exposure)', async () => {
    setToolState({
      agentSkills: [
        { description: 'A user skill', id: 'db-1', identifier: 'my-skill', name: 'My Skill' },
      ],
    });

    // pluginIds empty => skill is exposed (available list) but not pinned
    const result = await resolveClientSkills([]);

    expect(mockedGetById).not.toHaveBeenCalled();
    const skill = findSkill(result.skills, 'my-skill');
    expect(skill?.content).toBeUndefined();
    expect(skill?.activated).toBeFalsy();
  });

  it('does NOT pre-activate a pinned DB skill bundled as a ZIP', async () => {
    // Bundled skills must go through activateSkill so the server mounts the bundle;
    // pre-injecting content here would reference scripts/resources that are not mounted.
    setToolState({
      agentSkills: [
        {
          description: 'bundled',
          id: 'db-1',
          identifier: 'zip-skill',
          name: 'Zip Skill',
          zipFileHash: 'hash-abc',
        },
      ],
    });

    const result = await resolveClientSkills(['zip-skill']);

    expect(mockedGetById).not.toHaveBeenCalled();
    const skill = findSkill(result.skills, 'zip-skill');
    expect(skill?.content).toBeUndefined();
    expect(skill?.activated).toBeFalsy();
  });

  it('prefers the cached skill detail over a network fetch', async () => {
    setToolState({
      agentSkillDetailMap: {
        'db-1': { content: 'cached body', id: 'db-1', identifier: 'my-skill', name: 'My Skill' },
      },
      agentSkills: [{ description: '', id: 'db-1', identifier: 'my-skill', name: 'My Skill' }],
    });

    const result = await resolveClientSkills(['my-skill']);

    expect(mockedGetById).not.toHaveBeenCalled();
    expect(findSkill(result.skills, 'my-skill')).toMatchObject({
      activated: true,
      content: 'cached body',
    });
  });

  it('degrades gracefully when a pinned DB skill content fetch fails', async () => {
    setToolState({
      agentSkills: [{ description: '', id: 'db-1', identifier: 'my-skill', name: 'My Skill' }],
    });
    mockedGetById.mockRejectedValue(new Error('network down'));

    const result = await resolveClientSkills(['my-skill']);

    // No throw; skill still listed (available, not activated), just without content.
    const skill = findSkill(result.skills, 'my-skill');
    expect(skill).toMatchObject({ identifier: 'my-skill' });
    expect(skill?.content).toBeUndefined();
    expect(skill?.activated).toBeFalsy();
  });

  describe('disabled skills', () => {
    it('excludes a disabled DB skill entirely, not just from the pinned set', async () => {
      setToolState({
        agentSkills: [
          { description: 'A user skill', id: 'db-1', identifier: 'my-skill', name: 'My Skill' },
        ],
      });

      const result = await resolveClientSkills([], ['my-skill']);

      // Not merely unpinned — absent from the candidate pool entirely, so it
      // can't be listed in <available_skills> or resolved by activateSkill.
      expect(findSkill(result.skills, 'my-skill')).toBeUndefined();
    });

    it('excludes a disabled builtin skill entirely', async () => {
      setToolState({
        builtinSkills: [
          {
            content: '<artifacts_guide>build UI</artifacts_guide>',
            description: 'Generate interactive UI',
            identifier: 'artifacts',
            name: 'Artifacts',
            source: 'builtin',
          },
        ],
      });

      const result = await resolveClientSkills([], ['artifacts']);

      expect(findSkill(result.skills, 'artifacts')).toBeUndefined();
    });

    it('keeps a non-disabled skill even when other skills are disabled', async () => {
      setToolState({
        agentSkills: [
          { description: '', id: 'db-1', identifier: 'disabled-skill', name: 'Disabled' },
          { description: '', id: 'db-2', identifier: 'enabled-skill', name: 'Enabled' },
        ],
      });

      const result = await resolveClientSkills([], ['disabled-skill']);

      expect(findSkill(result.skills, 'disabled-skill')).toBeUndefined();
      expect(findSkill(result.skills, 'enabled-skill')).toBeDefined();
    });
  });

  describe('managed Published Catalog', () => {
    const catalogSkill = (
      skillKey: string,
      distribution: 'mandatory' | 'default' | 'optional',
    ) => ({
      checksum: skillKey.padEnd(64, 'a').slice(0, 64),
      description: `${skillKey} description`,
      displayName: skillKey,
      distribution,
      skillKey,
      source: 'uploaded' as const,
      version: '1.0.0',
    });

    it('applies distribution semantics and ignores legacy personal candidates', async () => {
      setToolState({
        agentSkills: [
          { description: 'personal', id: 'db-1', identifier: 'personal', name: 'Personal' },
        ],
        builtinSkills: [
          { content: 'legacy', description: 'legacy', identifier: 'legacy', name: 'Legacy' },
        ],
        platformSkillCatalog: {
          revision: 'catalog-1',
          skills: [
            catalogSkill('mandatory', 'mandatory'),
            catalogSkill('default', 'default'),
            catalogSkill('optional', 'optional'),
          ],
        },
        platformSkillRuntimeStatus: 'ready',
      });
      mockedResolvePlatformPinned.mockImplementation(
        async (ref) =>
          ({
            checksum: ref.checksum,
            content: `${ref.skillKey} body`,
            description: `${ref.skillKey} description`,
            identifier: ref.skillKey,
            name: ref.skillKey,
            resources: [],
            version: ref.version,
          }) as any,
      );

      const result = await resolveClientSkills(['optional'], ['mandatory', 'default']);

      expect(result.skills.map((skill) => skill.identifier)).toEqual(['mandatory', 'optional']);
      expect(findSkill(result.skills, 'optional')).toMatchObject({
        activated: true,
        content: 'optional body',
      });
      expect(result.platformCatalog).toMatchObject({
        mandatorySkillIds: ['mandatory'],
        refs: [
          expect.objectContaining({ skillKey: 'mandatory', version: '1.0.0' }),
          expect.objectContaining({ skillKey: 'optional', version: '1.0.0' }),
        ],
        revision: 'catalog-1',
      });
      expect(findSkill(result.skills, 'personal')).toBeUndefined();
      expect(findSkill(result.skills, 'legacy')).toBeUndefined();
    });

    it('fails closed when a pinned published Skill cannot be resolved', async () => {
      setToolState({
        platformSkillCatalog: {
          revision: 'catalog-1',
          skills: [catalogSkill('optional', 'optional')],
        },
        platformSkillRuntimeStatus: 'ready',
      });
      mockedResolvePlatformPinned.mockRejectedValue(new Error('not found'));

      await expect(resolveClientSkills(['optional'])).rejects.toThrow('not found');
    });

    it('keeps mandatory Skills available and activated in manual mode', async () => {
      setToolState({
        platformSkillCatalog: {
          revision: 'catalog-1',
          skills: [catalogSkill('mandatory', 'mandatory')],
        },
        platformSkillRuntimeStatus: 'ready',
      });
      mockedResolvePlatformPinned.mockResolvedValue({
        checksum: catalogSkill('mandatory', 'mandatory').checksum,
        content: 'mandatory body',
        description: 'mandatory description',
        identifier: 'mandatory',
        name: 'mandatory',
        resources: [],
        version: '1.0.0',
      } as any);

      const result = await resolveClientSkills([], ['mandatory']);

      expect(findSkill(result.skills, 'mandatory')).toMatchObject({
        activated: true,
        content: 'mandatory body',
      });
      expect(result.platformCatalog?.mandatorySkillIds).toEqual(['mandatory']);
    });

    it('bounds concurrent resolvePlatformPinned calls and stays linear on a large catalog', async () => {
      // mandatory + auto is always activated → every entry needs an exact pin resolve.
      const catalogSize = 10_000;
      const skills = Array.from({ length: catalogSize }, (_, index) =>
        catalogSkill(`mandatory-${index}`, 'mandatory'),
      );
      setToolState({
        platformSkillCatalog: { revision: 'catalog-large', skills },
        platformSkillRuntimeStatus: 'ready',
      });

      let inFlight = 0;
      let peakInFlight = 0;
      mockedResolvePlatformPinned.mockImplementation(async (ref) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return {
          checksum: ref.checksum,
          content: `${ref.skillKey} body`,
          description: `${ref.skillKey} description`,
          identifier: ref.skillKey,
          name: ref.skillKey,
          resources: [],
          version: ref.version,
        } as any;
      });

      const result = await resolveClientSkills([]);

      expect(result.skills).toHaveLength(catalogSize);
      expect(result.platformCatalog?.refs).toHaveLength(catalogSize);
      expect(result.platformCatalog?.skills).toHaveLength(catalogSize);
      expect(mockedResolvePlatformPinned).toHaveBeenCalledTimes(catalogSize);
      expect(peakInFlight).toBeLessThanOrEqual(PLATFORM_SKILL_RESOLVE_CONCURRENCY);
      expect(PLATFORM_SKILL_RESOLVE_CONCURRENCY).toBeGreaterThan(0);
    });
  });
});
