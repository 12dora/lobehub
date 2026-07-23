// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { flattenLeaves, getByPath, setByPath, splitSettingPath } from './pathUtils';

describe('pathUtils', () => {
  it('splitSettingPath rejects invalid segments', () => {
    expect(splitSettingPath('general.fontSize')).toEqual(['general', 'fontSize']);
    expect(splitSettingPath('')).toEqual([]);
    expect(splitSettingPath('a..b')).toEqual([]);
    expect(splitSettingPath('__proto__.x')).toEqual([]);
  });

  it('getByPath / setByPath are immutable', () => {
    const root = { general: { fontSize: 14, telemetry: true } };
    expect(getByPath(root, 'general.fontSize')).toBe(14);

    const next = setByPath(root, 'general.fontSize', 18);
    expect(root.general.fontSize).toBe(14);
    expect(getByPath(next, 'general.fontSize')).toBe(18);
    expect(getByPath(next, 'general.telemetry')).toBe(true);
  });

  it('flattenLeaves walks plain objects only', () => {
    const leaves = flattenLeaves({
      general: { fontSize: 14, tags: ['a'] },
      tool: { humanIntervention: { approvalMode: 'manual' } },
    });
    expect(leaves).toEqual(
      expect.arrayContaining([
        { path: 'general.fontSize', value: 14 },
        { path: 'general.tags', value: ['a'] },
        { path: 'tool.humanIntervention.approvalMode', value: 'manual' },
      ]),
    );
  });
});
