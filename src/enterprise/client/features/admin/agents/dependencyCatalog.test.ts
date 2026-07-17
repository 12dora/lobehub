import { describe, expect, it } from 'vitest';

import {
  buildModelDependency,
  buildSkillDependency,
  type ProviderPublishedDetail,
  type ProviderRevisionRef,
  resolveProviderModelSource,
  toDependencySnapshot,
  withModel,
  withSkillAdded,
  withSkillRemoved,
} from './dependencyCatalog';
import type { AdminAgentDraftDependencies } from './types';

const detail: ProviderPublishedDetail = {
  models: [
    { displayName: 'GPT-4.1', modelKey: 'gpt-4.1', type: 'chat' },
    { displayName: 'Embed', modelKey: 'text-embedding', type: 'embedding' },
  ],
  providerKey: 'openai',
  revision: 4,
};

const revisions: ProviderRevisionRef[] = [
  { checksum: 'c'.repeat(64), revision: 5, status: 'draft' },
  { checksum: 'a'.repeat(64), revision: 4, status: 'published' },
  { checksum: 'b'.repeat(64), revision: 3, status: 'archived' },
];

const empty = (): AdminAgentDraftDependencies => ({ connectors: [], model: null, skills: [] });

describe('dependencyCatalog exact resolution', () => {
  it('resolves the exact provider revision + checksum and filters to chat models', () => {
    const source = resolveProviderModelSource(detail, revisions);
    expect(source).toEqual({
      chatModels: [{ displayName: 'GPT-4.1', modelKey: 'gpt-4.1', type: 'chat' }],
      providerChecksum: 'a'.repeat(64),
      providerKey: 'openai',
      providerRevision: 4,
    });
  });

  it('returns null when the published revision has no matching published checksum', () => {
    expect(resolveProviderModelSource(detail, [])).toBeNull();
    expect(
      resolveProviderModelSource(detail, [
        { checksum: 'a'.repeat(64), revision: 4, status: 'draft' },
      ]),
    ).toBeNull();
    expect(resolveProviderModelSource(null, revisions)).toBeNull();
  });

  it('builds a first exact model dependency without fabricating metadata', () => {
    const source = resolveProviderModelSource(detail, revisions)!;
    const deps = withModel(empty(), buildModelDependency(source, 'gpt-4.1'));
    expect(deps.model).toEqual({
      modelKey: 'gpt-4.1',
      providerChecksum: 'a'.repeat(64),
      providerKey: 'openai',
      providerRevision: 4,
    });
  });

  it('replaces the FULL model ref on switch — no stale checksum/revision survives', () => {
    const first = resolveProviderModelSource(detail, revisions)!;
    let deps = withModel(empty(), buildModelDependency(first, 'gpt-4.1'));

    const nextDetail: ProviderPublishedDetail = {
      models: [{ displayName: 'Claude', modelKey: 'claude-sonnet', type: 'chat' }],
      providerKey: 'anthropic',
      revision: 9,
    };
    const nextSource = resolveProviderModelSource(nextDetail, [
      { checksum: 'd'.repeat(64), revision: 9, status: 'published' },
    ])!;
    deps = withModel(deps, buildModelDependency(nextSource, 'claude-sonnet'));

    expect(deps.model).toEqual({
      modelKey: 'claude-sonnet',
      providerChecksum: 'd'.repeat(64),
      providerKey: 'anthropic',
      providerRevision: 9,
    });
  });

  it('adds, replaces (by key), and removes exact skill dependencies', () => {
    let deps = empty();
    deps = withSkillAdded(
      deps,
      buildSkillDependency({
        checksum: 'e'.repeat(64),
        displayName: 'Writer',
        distribution: 'optional',
        skillKey: 'writer',
        version: '1.0.0',
      }),
    );
    expect(deps.skills).toEqual([
      { checksum: 'e'.repeat(64), skillKey: 'writer', version: '1.0.0' },
    ]);

    // Same skillKey, newer version → replace, not duplicate.
    deps = withSkillAdded(
      deps,
      buildSkillDependency({
        checksum: 'f'.repeat(64),
        displayName: 'Writer',
        distribution: 'optional',
        skillKey: 'writer',
        version: '1.1.0',
      }),
    );
    expect(deps.skills).toEqual([
      { checksum: 'f'.repeat(64), skillKey: 'writer', version: '1.1.0' },
    ]);

    deps = withSkillRemoved(deps, 'writer');
    expect(deps.skills).toEqual([]);
  });

  it('builds the contract snapshot only when the model is resolved', () => {
    expect(toDependencySnapshot(empty())).toBeNull();
    const source = resolveProviderModelSource(detail, revisions)!;
    const deps = withModel(empty(), buildModelDependency(source, 'gpt-4.1'));
    expect(toDependencySnapshot(deps)).toEqual({
      connectors: [],
      model: deps.model,
      skills: [],
    });
  });
});
