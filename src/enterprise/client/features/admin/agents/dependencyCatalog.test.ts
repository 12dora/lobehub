import { describe, expect, it } from 'vitest';

import {
  allowedConnectorToolKeys,
  buildConnectorDependency,
  buildModelDependency,
  buildSkillDependency,
  isConnectorCurrent,
  isModelCurrent,
  type ProviderPublishedDetail,
  type ProviderRevisionRef,
  type PublishedConnectorDetail,
  resolveProviderModelSource,
  staleConnectorKeys,
  staleSkillKeys,
  toDependencySnapshot,
  withConnectorAdded,
  withConnectorRemoved,
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

const connectorDetail: PublishedConnectorDetail = {
  connectorId: 'connector-1',
  connectorKey: 'issues',
  publishedChecksum: 'a'.repeat(64),
  publishedRevision: 3,
  tools: [
    { platformPolicy: 'allow', toolKey: 'search' },
    { platformPolicy: 'deny', toolKey: 'delete' },
    { platformPolicy: 'confirm', toolKey: 'create' },
  ],
};

describe('dependencyCatalog connector authoring', () => {
  it('excludes deny-policy tools from the allowed set', () => {
    expect(allowedConnectorToolKeys(connectorDetail)).toEqual(['search', 'create']);
  });

  it('builds an exact connector ref and adds / replaces / removes by key', () => {
    const ref = buildConnectorDependency(connectorDetail, ['search']);
    expect(ref).toEqual({
      allowedToolKeys: ['search'],
      connectorId: 'connector-1',
      connectorKey: 'issues',
      publishedChecksum: 'a'.repeat(64),
      publishedRevision: 3,
    });

    let deps = withConnectorAdded(empty(), ref);
    expect(deps.connectors).toHaveLength(1);
    // Re-adding the same key REPLACES (e.g. update to a newer published revision).
    deps = withConnectorAdded(deps, { ...ref, publishedRevision: 4 });
    expect(deps.connectors).toEqual([{ ...ref, publishedRevision: 4 }]);
    deps = withConnectorRemoved(deps, 'issues');
    expect(deps.connectors).toEqual([]);
  });
});

describe('dependencyCatalog validation against the current published catalog', () => {
  it('treats a model as current only on an exact provider/revision/checksum/model match', () => {
    const source = resolveProviderModelSource(detail, revisions)!;
    const model = buildModelDependency(source, 'gpt-4.1');
    expect(isModelCurrent(model, source)).toBe(true);
    expect(isModelCurrent(null, source)).toBe(false);
    expect(isModelCurrent(model, undefined)).toBe(false);
    expect(isModelCurrent({ ...model, providerChecksum: 'z'.repeat(64) }, source)).toBe(false);
    expect(isModelCurrent({ ...model, providerRevision: 99 }, source)).toBe(false);
    expect(isModelCurrent({ ...model, modelKey: 'gone' }, source)).toBe(false);
  });

  const skillOption = (over: Record<string, unknown> = {}) => ({
    checksum: 'a'.repeat(64),
    displayName: 'W',
    distribution: 'optional',
    skillKey: 'writer',
    version: '1.0.0',
    ...over,
  });

  it('exact-matches skills on all contract fields and FAILS CLOSED on an unsettled catalog', () => {
    const skills = [{ checksum: 'a'.repeat(64), skillKey: 'writer', version: '1.0.0' }];
    // Undefined catalog cannot be verified → treated as stale (fail closed), not "no stale refs".
    expect(staleSkillKeys(skills, undefined)).toEqual(['writer']);
    expect(staleSkillKeys(skills, [])).toEqual(['writer']);
    expect(staleSkillKeys(skills, [skillOption()])).toEqual([]);
    expect(staleSkillKeys(skills, [skillOption({ checksum: 'b'.repeat(64) })])).toEqual(['writer']);
    expect(staleSkillKeys(skills, [skillOption({ version: '1.1.0' })])).toEqual(['writer']);
  });

  const connectorRef = (over: Record<string, unknown> = {}) => ({
    allowedToolKeys: ['search', 'create'],
    connectorId: 'connector-1',
    connectorKey: 'issues',
    publishedChecksum: 'a'.repeat(64),
    publishedRevision: 3,
    ...over,
  });

  it('validates the COMPLETE connector tuple against the fetched detail', () => {
    const ref = connectorRef();
    expect(isConnectorCurrent(ref, connectorDetail)).toBe(true);
    expect(isConnectorCurrent(ref, null)).toBe(false); // missing / unpublished
    expect(isConnectorCurrent({ ...ref, connectorId: 'other' }, connectorDetail)).toBe(false);
    expect(isConnectorCurrent({ ...ref, connectorKey: 'other' }, connectorDetail)).toBe(false);
    expect(isConnectorCurrent({ ...ref, publishedChecksum: 'z'.repeat(64) }, connectorDetail)).toBe(
      false,
    );
    expect(isConnectorCurrent({ ...ref, publishedRevision: 9 }, connectorDetail)).toBe(false);
    // Order canonicalization: same allowed set in a different order is still current.
    expect(
      isConnectorCurrent({ ...ref, allowedToolKeys: ['create', 'search'] }, connectorDetail),
    ).toBe(true);
    // A referenced tool that was removed / denied is stale.
    expect(isConnectorCurrent({ ...ref, allowedToolKeys: ['search'] }, connectorDetail)).toBe(
      false,
    ); // 'create' dropped
    expect(
      isConnectorCurrent(
        { ...ref, allowedToolKeys: ['search', 'create', 'extra'] },
        connectorDetail,
      ),
    ).toBe(false);
    // A newly-denied tool (deny excluded from the allowed set) makes a ref referencing it stale.
    const denied = {
      ...connectorDetail,
      tools: [
        { platformPolicy: 'deny', toolKey: 'search' },
        { platformPolicy: 'allow', toolKey: 'create' },
      ],
    };
    expect(isConnectorCurrent(connectorRef({ allowedToolKeys: ['create'] }), denied)).toBe(true);
    expect(isConnectorCurrent(ref, denied)).toBe(false);
  });

  it('staleConnectorKeys FAILS CLOSED on an unsettled details map and flags exact mismatches', () => {
    const connectors = [connectorRef()];
    // Details not loaded → stale (fail closed).
    expect(staleConnectorKeys(connectors, undefined)).toEqual(['issues']);
    // Referenced connector unpublished/missing → stale.
    expect(staleConnectorKeys(connectors, { 'connector-1': null })).toEqual(['issues']);
    // Exact tuple match → current.
    expect(staleConnectorKeys(connectors, { 'connector-1': connectorDetail })).toEqual([]);
    // Revision drift → stale.
    expect(
      staleConnectorKeys(connectors, {
        'connector-1': { ...connectorDetail, publishedRevision: 4 },
      }),
    ).toEqual(['issues']);
  });
});
