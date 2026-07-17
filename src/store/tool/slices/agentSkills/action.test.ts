import { describe, expect, it } from 'vitest';

import type { StoreSetter } from '@/store/types';

import type { ToolStore } from '../../store';
import { AgentSkillsActionImpl } from './action';

const createHarness = (overrides: Partial<ToolStore> = {}) => {
  let state = {
    platformSkillCatalog: {
      revision: 'catalog-1',
      skills: [{ skillKey: 'approved.skill' }],
    },
    platformSkillCatalogInvalidationRevision: '0',
    platformSkillCatalogRequestEpoch: 5,
    platformSkillRuntimeManaged: true,
    platformSkillRuntimeStatus: 'ready',
    ...overrides,
  } as unknown as ToolStore;
  const setState: StoreSetter<ToolStore> = (partial) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...next };
  };
  const action = new AgentSkillsActionImpl(setState, () => state);
  return { action, getState: () => state };
};

describe('AgentSkillsActionImpl managed catalog state', () => {
  it('preserves a ready catalog and request epoch across managed capability refresh', () => {
    const { action, getState } = createHarness();

    action.configurePlatformSkillManagement(true);

    expect(getState()).toMatchObject({
      platformSkillCatalogRequestEpoch: 5,
      platformSkillRuntimeManaged: true,
      platformSkillRuntimeStatus: 'ready',
    });
  });

  it('does not invalidate an in-flight catalog response on same-key capability refresh', () => {
    const { action, getState } = createHarness();
    const epoch = action.beginPlatformSkillCatalogRequest();

    action.configurePlatformSkillManagement(true);
    action.completePlatformSkillCatalogRequest(epoch, {
      revision: 'catalog-2',
      skills: [
        {
          checksum: 'a'.repeat(64),
          description: null,
          displayName: 'Second',
          distribution: 'default',
          skillKey: 'second.skill',
          source: 'uploaded',
          version: '1.0.0',
        },
      ],
    });

    expect(getState()).toMatchObject({
      platformSkillCatalog: { revision: 'catalog-2' },
      platformSkillCatalogRequestEpoch: 6,
      platformSkillRuntimeStatus: 'ready',
    });
  });
});
