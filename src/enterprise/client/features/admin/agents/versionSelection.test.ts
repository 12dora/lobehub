import { describe, expect, it } from 'vitest';

import type { AdminAgentDetailOutput } from './types';
import {
  selectCurrentPlatformAgentVersion,
  selectDraftSourcePlatformAgentVersion,
  selectLatestPlatformAgentVersion,
  sortPlatformAgentVersionsDesc,
} from './versionSelection';

const version = (
  id: string,
  createdAt: string,
  versionLabel = '1.0.0',
): AdminAgentDetailOutput['versions'][number] => ({
  agentId: 'agent-1',
  checksum: 'c'.repeat(64),
  config: {
    avatar: null,
    backgroundColor: null,
    description: null,
    displayName: id,
    modelParameters: {},
    openingMessage: null,
    openingQuestions: [],
    systemRole: 'role',
    tags: [],
  },
  createdAt: new Date(createdAt),
  createdBy: 'admin',
  dependencySnapshot: {
    connectors: [],
    model: {
      modelKey: 'gpt-test',
      providerChecksum: 'p'.repeat(64),
      providerKey: 'openai',
      providerRevision: 1,
    },
    skills: [],
  },
  id,
  version: versionLabel,
});

describe('versionSelection (canonical newest-first order)', () => {
  it('sorts by createdAt desc with id tie-break, ignoring opaque array position', () => {
    // Lexicographically id "z-old" > "a-new", but createdAt must win.
    const shuffled = [
      version('z-old', '2026-01-01T00:00:00.000Z', '1.0.0'),
      version('m-mid', '2026-06-01T00:00:00.000Z', '1.1.0'),
      version('a-new', '2026-07-01T00:00:00.000Z', '2.0.0'),
    ];
    expect(sortPlatformAgentVersionsDesc(shuffled).map(({ id }) => id)).toEqual([
      'a-new',
      'm-mid',
      'z-old',
    ]);
    expect(selectLatestPlatformAgentVersion(shuffled)?.id).toBe('a-new');
  });

  it('breaks equal createdAt ties by id descending', () => {
    const sameInstant = '2026-07-01T12:00:00.000Z';
    const rows = [
      version('ver-aaa', sameInstant),
      version('ver-zzz', sameInstant),
      version('ver-mmm', sameInstant),
    ];
    expect(sortPlatformAgentVersionsDesc(rows).map(({ id }) => id)).toEqual([
      'ver-zzz',
      'ver-mmm',
      'ver-aaa',
    ]);
  });

  it('selects current by pointer and draft source by latest creation, not versions[0]', () => {
    const versions = [
      version('old-first-in-array', '2026-01-01T00:00:00.000Z', '0.1.0'),
      version('published-current', '2026-03-01T00:00:00.000Z', '1.0.0'),
      version('newest-draft', '2026-07-01T00:00:00.000Z', '1.1.0'),
    ];
    const snapshot = {
      identity: { currentVersionId: 'published-current' },
      versions,
    } as Pick<AdminAgentDetailOutput, 'identity' | 'versions'>;

    expect(selectCurrentPlatformAgentVersion(snapshot)?.id).toBe('published-current');
    expect(selectLatestPlatformAgentVersion(versions)?.id).toBe('newest-draft');
    // Draft seed must be the newest created row, not the opaque array head or the published pointer.
    expect(selectDraftSourcePlatformAgentVersion(snapshot)?.id).toBe('newest-draft');
    expect(versions[0]?.id).toBe('old-first-in-array');
  });
});
