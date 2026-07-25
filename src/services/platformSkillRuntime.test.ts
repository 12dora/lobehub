import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getToolStoreState } from '@/store/tool';

import { clientSkillRuntimeService, createClientSkillRuntimeService } from './platformSkillRuntime';
import { agentSkillService } from './skill';

vi.mock('@/store/tool', () => ({ getToolStoreState: vi.fn() }));
vi.mock('./skill', () => ({
  agentSkillService: {
    getById: vi.fn(),
    getByName: vi.fn(),
    list: vi.fn(),
    readResource: vi.fn(),
    resolvePlatformPinned: vi.fn(),
  },
}));

const state = vi.mocked(getToolStoreState);
const resolvePinned = vi.mocked(agentSkillService.resolvePlatformPinned);
const published = {
  checksum: 'a'.repeat(64),
  description: 'Approved',
  displayName: 'Approved Skill',
  distribution: 'default' as const,
  skillKey: 'approved.skill',
  source: 'uploaded' as const,
  version: '1.0.0',
};

describe('clientSkillRuntimeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.mockReturnValue({
      platformSkillCatalog: { revision: 'catalog-1', skills: [published] },
      platformSkillRuntimeStatus: 'ready',
    } as never);
    resolvePinned.mockResolvedValue({
      checksum: published.checksum,
      content: 'approved body',
      description: published.description,
      identifier: published.skillKey,
      name: published.displayName,
      resources: [
        {
          checksum: 'b'.repeat(64),
          content: '',
          mediaType: 'text/plain',
          path: 'empty.txt',
          sizeBytes: 0,
        },
      ],
      version: published.version,
    } as never);
  });

  it('resolves by stable key using the exact published pin', async () => {
    await expect(clientSkillRuntimeService.findByName('approved.skill')).resolves.toMatchObject({
      content: 'approved body',
      identifier: 'approved.skill',
    });
    expect(resolvePinned).toHaveBeenCalledWith({
      checksum: published.checksum,
      skillKey: published.skillKey,
      version: published.version,
    });
  });

  it('fails closed instead of falling back to personal or static builtin Skills', async () => {
    await expect(clientSkillRuntimeService.findByName('personal.skill')).rejects.toThrow(
      'Managed Skill is not published',
    );
    expect(agentSkillService.getByName).not.toHaveBeenCalled();
  });

  it('preserves a valid empty resource body', async () => {
    const listed = await clientSkillRuntimeService.findAll();
    const id = listed.data[0]!.id;
    await expect(clientSkillRuntimeService.readResource(id, 'empty.txt')).resolves.toMatchObject({
      content: '',
      path: 'empty.txt',
    });
  });

  it('uses the unchanged legacy path when no managed catalog is present', async () => {
    state.mockReturnValue({
      platformSkillCatalog: null,
      platformSkillRuntimeStatus: 'unmanaged',
    } as never);
    vi.mocked(agentSkillService.getByName).mockResolvedValue(undefined);

    await clientSkillRuntimeService.findByName('personal.skill');

    expect(agentSkillService.getByName).toHaveBeenCalledWith('personal.skill');
    expect(resolvePinned).not.toHaveBeenCalled();
  });

  it.each(['loading', 'error'] as const)(
    'fails closed while managed runtime is %s',
    async (status) => {
      state.mockReturnValue({
        platformSkillCatalog: null,
        platformSkillRuntimeStatus: status,
      } as never);

      await expect(clientSkillRuntimeService.findAll()).rejects.toThrow(
        'Managed Skill runtime catalog is unavailable',
      );
      expect(agentSkillService.list).not.toHaveBeenCalled();
    },
  );

  it('keeps an operation on its captured v1 ref after the global catalog moves to v2', async () => {
    const snapshot = {
      mandatorySkillIds: [],
      refs: [{ checksum: published.checksum, skillKey: published.skillKey, version: '1.0.0' }],
      revision: 'catalog-v1',
    };
    const runtime = createClientSkillRuntimeService(snapshot);
    state.mockReturnValue({
      platformSkillCatalog: {
        revision: 'catalog-v2',
        skills: [{ ...published, checksum: 'b'.repeat(64), version: '2.0.0' }],
      },
      platformSkillRuntimeStatus: 'ready',
    } as never);

    await runtime.findByName('approved.skill');

    expect(resolvePinned).toHaveBeenCalledWith(
      {
        checksum: published.checksum,
        skillKey: published.skillKey,
        version: '1.0.0',
      },
      snapshot,
    );
  });

  it('lists a 10,000-item operation index without concurrent resolution requests', async () => {
    const runtime = createClientSkillRuntimeService({
      mandatorySkillIds: [],
      refs: Array.from({ length: 10_000 }, (_, index) => ({
        checksum: published.checksum,
        skillKey: `approved.skill.${index}`,
        version: '1.0.0',
      })),
      revision: 'catalog-large',
    });

    await expect(runtime.findAll()).resolves.toMatchObject({ total: 10_000 });
    await expect(runtime.findByName('missing.skill')).resolves.toBeUndefined();
    expect(resolvePinned).not.toHaveBeenCalled();
  });

  it('returns independent clones from the exact operation cache', async () => {
    const runtime = createClientSkillRuntimeService({
      mandatorySkillIds: [],
      refs: [{ checksum: published.checksum, skillKey: published.skillKey, version: '1.0.0' }],
      revision: 'catalog-v1',
    });

    const first = await runtime.findByName('approved.skill');
    first!.content = 'attacker mutation';
    first!.manifest!.name = 'attacker.skill';
    first!.resources!['empty.txt']!.content = 'attacker resource';
    const second = await runtime.findByName('approved.skill');

    expect(second).toMatchObject({
      content: 'approved body',
      manifest: { name: 'approved.skill' },
      resources: { 'empty.txt': { content: '' } },
    });
    expect(resolvePinned).toHaveBeenCalledTimes(1);
  });

  it('evicts a rejected resolution so a later lookup can succeed', async () => {
    const runtime = createClientSkillRuntimeService({
      mandatorySkillIds: [],
      refs: [{ checksum: published.checksum, skillKey: published.skillKey, version: '1.0.0' }],
      revision: 'catalog-v1',
    });
    const transient = new Error('transient network');
    resolvePinned.mockRejectedValueOnce(transient).mockResolvedValueOnce({
      checksum: published.checksum,
      content: 'approved body',
      description: published.description,
      identifier: published.skillKey,
      name: published.displayName,
      resources: [
        {
          checksum: 'b'.repeat(64),
          content: '',
          mediaType: 'text/plain',
          path: 'empty.txt',
          sizeBytes: 0,
        },
      ],
      version: '1.0.0',
    } as never);

    await expect(runtime.findByName('approved.skill')).rejects.toBe(transient);
    await expect(runtime.findByName('approved.skill')).resolves.toMatchObject({
      content: 'approved body',
      identifier: published.skillKey,
    });
    expect(resolvePinned).toHaveBeenCalledTimes(2);
  });
});
