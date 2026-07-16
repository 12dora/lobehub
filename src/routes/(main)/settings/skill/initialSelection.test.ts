import { describe, expect, it } from 'vitest';

import { resolveInitialToolSelection } from './initialSelection';

describe('ToolSettings initial selection', () => {
  it('never selects hidden builtin definitions for a managed Connector surface', () => {
    expect(
      resolveInitialToolSelection({
        builtinSkills: [{ identifier: 'artifact' }],
        builtinTools: [{ identifier: 'search' }],
        installedBuiltinIds: ['search'],
        managed: true,
        viewMode: 'connector',
      }),
    ).toBeNull();
  });

  it('preserves unmanaged Connector and Skill defaults', () => {
    expect(
      resolveInitialToolSelection({
        builtinSkills: [],
        builtinTools: [{ identifier: 'search' }],
        installedBuiltinIds: ['search'],
        managed: false,
        viewMode: 'connector',
      }),
    ).toEqual({ identifier: 'search', type: 'builtin' });
    expect(
      resolveInitialToolSelection({
        builtinSkills: [{ identifier: 'artifact' }],
        builtinTools: [],
        installedBuiltinIds: [],
        managed: false,
        viewMode: 'skill',
      }),
    ).toEqual({ identifier: 'artifact', type: 'builtin-skill' });
  });
});
