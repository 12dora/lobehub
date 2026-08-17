import { describe, expect, it, vi } from 'vitest';

import { createMockAdminAgentsClient } from './__tests__/mockAdminAgents';
import {
  fetchAdminAgentDetail,
  fetchPublishedAdminAgentReplacements,
  findDefaultAdminAgent,
} from './useAdminAgents';

describe('Admin Agent detail aggregate through the injected client boundary', () => {
  it('pages versions until the PUBLISHED pointer is loaded, never settling for page one', async () => {
    const client = createMockAdminAgentsClient();
    const detail0 = await client.get({ id: 'agent-inbox' });
    const current = (await client.listVersions({ agentId: 'agent-inbox' })).items.find(
      ({ id }) => id === detail0.identity.currentVersionId,
    )!;
    // Page 1 holds a DIFFERENT version; the pointer only arrives on page 2.
    const listVersions = vi
      .spyOn(client, 'listVersions')
      .mockResolvedValueOnce({
        items: [{ ...current, id: 'version-page-1', version: '9.9.9' }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({ items: [current], nextCursor: null });

    const detail = await fetchAdminAgentDetail('agent-inbox', client);

    expect(listVersions).toHaveBeenCalledTimes(2);
    expect(listVersions.mock.calls[1]![0]).toMatchObject({ cursor: 'page-2' });
    // The editor seeds from this exact row — it must be present, not approximated.
    expect(detail.versions.map(({ id }) => id)).toContain(current.id);
    expect(detail.collectionMeta?.versionsTruncated).toBe(false);
  });

  it('reports versions as truncated only when the page ceiling stopped the drain', async () => {
    const client = createMockAdminAgentsClient();
    const version = (await client.listVersions({ agentId: 'agent-inbox' })).items[0]!;
    // A cursor that never ends AND never yields the published pointer: the bounded loop must stop
    // and SAY the collection is incomplete rather than spinning.
    const listVersions = vi.spyOn(client, 'listVersions').mockResolvedValue({
      items: [{ ...version, id: 'not-the-pointer' }],
      nextCursor: 'never-ends',
    });

    const detail = await fetchAdminAgentDetail('agent-inbox', client);

    expect(listVersions.mock.calls.length).toBeLessThanOrEqual(20);
    expect(detail.collectionMeta?.versionsTruncated).toBe(true);
    expect(detail.collectionMeta?.versionsNextCursor).toBe('never-ends');
  });

  it('drains EVERY assignment page, because the editor writes a diff against that list', async () => {
    const client = createMockAdminAgentsClient();
    const first = (await client.listAssignments({ agentId: 'agent-inbox' })).items;
    const listAssignments = vi
      .spyOn(client, 'listAssignments')
      .mockResolvedValueOnce({ items: first, nextCursor: 'page-2' })
      .mockResolvedValueOnce({
        items: [
          {
            ...first[0]!,
            id: 'assignment-page-2',
            targetId: 'user-page-2',
            targetType: 'user' as const,
          },
        ],
        nextCursor: null,
      });

    const detail = await fetchAdminAgentDetail('agent-inbox', client);

    expect(listAssignments).toHaveBeenCalledTimes(2);
    expect(detail.assignments.map(({ id }) => id)).toContain('assignment-page-2');
    expect(detail.collectionMeta?.assignmentsTruncated).toBe(false);
  });

  it('marks assignments truncated when the ceiling stops the drain', async () => {
    const client = createMockAdminAgentsClient();
    const first = (await client.listAssignments({ agentId: 'agent-inbox' })).items;
    vi.spyOn(client, 'listAssignments').mockResolvedValue({ items: first, nextCursor: 'more' });

    const detail = await fetchAdminAgentDetail('agent-inbox', client);
    expect(detail.collectionMeta?.assignmentsTruncated).toBe(true);
  });

  it('skips rollout reads when the authoritative platform capability is off', async () => {
    const base = createMockAdminAgentsClient();
    const listRollouts = vi.spyOn(base, 'listRollouts');

    const detail = await fetchAdminAgentDetail('agent-inbox', base, false);

    expect(listRollouts).not.toHaveBeenCalled();
    expect(detail.rollouts).toEqual([]);
    expect(detail.versions.length).toBeGreaterThan(0);
  });

  it('sorts the bounded version page without following its opaque cursor', async () => {
    const client = createMockAdminAgentsClient();
    const version = (await client.listVersions({ agentId: 'agent-inbox' })).items[0]!;
    const listVersions = vi.spyOn(client, 'listVersions').mockResolvedValueOnce({
      // Older page-1 row first in opaque cursor order — aggregate must re-sort by createdAt.
      items: [
        { ...version, createdAt: new Date('2026-07-16T06:00:00.000Z'), id: 'version-inbox-1' },
        {
          ...version,
          createdAt: new Date('2026-07-17T06:00:00.000Z'),
          id: 'version-inbox-2',
          version: '1.0.1',
        },
      ],
      nextCursor: 'next-page',
    });

    const detail = await fetchAdminAgentDetail('agent-inbox', client);

    // Canonical aggregate order: newest createdAt first (not opaque page/id order).
    expect(detail.versions.map(({ id }) => id)).toEqual(['version-inbox-2', 'version-inbox-1']);
    expect(listVersions).toHaveBeenCalledTimes(1);
    expect(listVersions).toHaveBeenCalledWith({ agentId: 'agent-inbox', limit: 100 });
    expect(detail.collectionMeta?.versionsNextCursor).toBe('next-page');
  });
  it('resolves the default inbox via a dedicated isDefault list filter (no catalog drain)', async () => {
    const client = createMockAdminAgentsClient();
    const list = vi.spyOn(client, 'list');

    const found = await findDefaultAdminAgent(client);
    expect(found?.identity.isDefault).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ isDefault: true, limit: 1 });
  });

  it('loads one published replacement page without multi-page drain', async () => {
    const client = createMockAdminAgentsClient();
    const list = vi.spyOn(client, 'list');

    const items = await fetchPublishedAdminAgentReplacements('agent-inbox', client, {
      limit: 50,
      query: 'research',
    });
    expect(items.every(({ identity }) => identity.id !== 'agent-inbox')).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({
      limit: 50,
      query: 'research',
      status: 'published',
    });
  });
});
