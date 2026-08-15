import { describe, expect, it } from 'vitest';

import { applyAgentSaveOutputToDetail, applyAgentSaveOutputToListItem } from './applySaveOutput';
import type {
  AdminAgentDetailOutput,
  AdminAgentListItem,
  AdminPlatformAgentSaveOutput,
} from './types';

const model = {
  modelKey: 'gpt-4.1',
  providerChecksum: 'a'.repeat(64),
  providerKey: 'openai',
  providerRevision: 4,
};

const config = {
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName: 'Research',
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'Research carefully.',
  tags: [],
};

const version = (id: string, label: string, createdAt: string) => ({
  agentId: 'agent-1',
  checksum: 'c'.repeat(64),
  config,
  createdAt: new Date(createdAt),
  createdBy: 'admin-1',
  dependencySnapshot: { connectors: [], model, skills: [] },
  id,
  version: label,
});

const detail = {
  assignments: [],
  draftToken: 'b'.repeat(64),
  identity: {
    agentKey: 'research',
    currentVersionId: 'version-1',
    draftSequence: 1,
    id: 'agent-1',
    isDefault: false,
    migrationRequired: false,
    revision: 2,
    status: 'published',
    systemKey: null,
  },
  rollouts: [],
  versions: [version('version-1', '1.0.0', '2026-07-17T00:00:00Z')],
} as unknown as AdminAgentDetailOutput;

const output = {
  draftToken: 'e'.repeat(64),
  identity: { ...detail.identity, currentVersionId: 'version-2', revision: 3 },
  invalidationStatus: 'delivered',
  version: {
    ...version('version-2', '1.0.1', '2026-07-18T00:00:00Z'),
    config: { ...config, displayName: 'Research v2' },
  },
} as unknown as AdminPlatformAgentSaveOutput;

describe('applyAgentSaveOutputToDetail', () => {
  it('puts the committed CAS and the new version on the cached aggregate, newest first', () => {
    const applied = applyAgentSaveOutputToDetail(output)(detail)!;
    expect(applied.draftToken).toBe('e'.repeat(64));
    expect(applied.identity.revision).toBe(3);
    expect(applied.versions.map(({ version: label }) => label)).toEqual(['1.0.1', '1.0.0']);
    // The cached aggregate is replaced, never mutated in place.
    expect(detail.versions).toHaveLength(1);
  });

  it('never duplicates a version when the same output is applied twice', () => {
    const apply = applyAgentSaveOutputToDetail(output);
    const applied = apply(apply(detail));
    expect(applied!.versions.filter(({ id }) => id === 'version-2')).toHaveLength(1);
  });

  it('leaves an empty cache empty — there is nothing to patch onto', () => {
    expect(applyAgentSaveOutputToDetail(output)(undefined)).toBeUndefined();
  });
});

describe('applyAgentSaveOutputToListItem', () => {
  it('projects the committed name, published version and identity onto the row', () => {
    const item = {
      assignmentCount: 4,
      displayName: 'Research',
      identity: detail.identity,
      publishedVersion: '1.0.0',
    } as unknown as AdminAgentListItem;

    expect(applyAgentSaveOutputToListItem(output, item)).toEqual({
      assignmentCount: 4, // untouched: the save says nothing about assignments
      displayName: 'Research v2',
      identity: output.identity,
      publishedVersion: '1.0.1',
    });
  });
});
