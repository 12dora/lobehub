import { describe, expect, it } from 'vitest';

import { decideSkillHydration } from './skillHydration';

const changed = {
  allowedSkillId: null as string | null,
  currentHydrationKey: 'skill-1:3:old:true',
  dirty: false,
  hasSafeRecovery: false,
  hydrationKey: 'skill-2:1:new:true',
  rejectedHydrationKey: null as string | null,
  snapshotSkillId: 'skill-2',
};

describe('decideSkillHydration', () => {
  it('returns already-hydrated when the hydration key is unchanged', () => {
    expect(
      decideSkillHydration({
        ...changed,
        hydrationKey: 'skill-1:3:old:true',
        snapshotSkillId: 'skill-1',
      }),
    ).toEqual({ type: 'already-hydrated' });
  });

  it('returns hydrate-allowed when Leave already granted this skill id, even if dirty with no recovery', () => {
    expect(
      decideSkillHydration({
        ...changed,
        allowedSkillId: 'skill-2',
        dirty: true,
        hasSafeRecovery: false,
      }),
    ).toEqual({ type: 'hydrate-allowed' });
  });

  it('returns skip-rejected when this hydration key was already declined', () => {
    expect(
      decideSkillHydration({
        ...changed,
        dirty: true,
        rejectedHydrationKey: 'skill-2:1:new:true',
      }),
    ).toEqual({ type: 'skip-rejected' });
  });

  it('returns confirm when dirty with no safe recovery and the key changed', () => {
    expect(
      decideSkillHydration({
        ...changed,
        dirty: true,
        hasSafeRecovery: false,
      }),
    ).toEqual({ type: 'confirm' });
  });

  it('returns hydrate when dirty with a safe recovery copy and the key changed', () => {
    expect(
      decideSkillHydration({
        ...changed,
        dirty: true,
        hasSafeRecovery: true,
      }),
    ).toEqual({ type: 'hydrate' });
  });

  it('returns hydrate when the draft is clean and the key changed', () => {
    expect(decideSkillHydration(changed)).toEqual({ type: 'hydrate' });
  });

  it('lets the allowed Leave bypass win over a rejected hydration key', () => {
    expect(
      decideSkillHydration({
        ...changed,
        allowedSkillId: 'skill-2',
        dirty: true,
        hasSafeRecovery: false,
        rejectedHydrationKey: 'skill-2:1:new:true',
      }),
    ).toEqual({ type: 'hydrate-allowed' });
  });
});
