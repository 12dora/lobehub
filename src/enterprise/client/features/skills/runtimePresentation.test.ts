import { describe, expect, it } from 'vitest';

import { selectSkillRuntimeSources } from './runtimePresentation';

const catalog = { revision: 'r1', skills: [] };
const sources = { builtin: ['builtin'], market: ['market'], platform: catalog, user: ['user'] };

describe('selectSkillRuntimeSources', () => {
  it('uses legacy sources only while explicitly unmanaged', () => {
    expect(selectSkillRuntimeSources({ ...sources, status: 'unmanaged' })).toEqual({
      builtin: ['builtin'],
      market: ['market'],
      platform: null,
      user: ['user'],
    });
  });

  it.each(['loading', 'error'] as const)(
    'hides every stale Skill source while enforced runtime is %s',
    (status) => {
      expect(selectSkillRuntimeSources({ ...sources, status })).toEqual({
        builtin: [],
        market: [],
        platform: null,
        user: [],
      });
    },
  );

  it('uses only the platform catalog after enforced runtime is ready', () => {
    expect(selectSkillRuntimeSources({ ...sources, status: 'ready' })).toEqual({
      builtin: [],
      market: [],
      platform: catalog,
      user: [],
    });
  });
});
