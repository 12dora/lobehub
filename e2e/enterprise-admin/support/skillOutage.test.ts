import { describe, expect, it } from 'vitest';

import {
  countUserSkillArtifacts,
  induceSkillCatalogOutage,
  OUTAGE_SKILL_ID,
  OUTAGE_SKILL_KEY,
  restoreSkillCatalogOutage,
} from './skillOutage';

describe('skill catalog outage mechanism', () => {
  it('exports induce/restore/count as a reversible pair with stable probe ids', () => {
    expect(typeof induceSkillCatalogOutage).toBe('function');
    expect(typeof restoreSkillCatalogOutage).toBe('function');
    expect(typeof countUserSkillArtifacts).toBe('function');
    expect(OUTAGE_SKILL_ID).toMatch(/^pskill_/);
    expect(OUTAGE_SKILL_KEY).toBe('e2e.skill.outage.probe');
  });

  it('outage induction writes platform_skills broken pointer (source contract)', () => {
    const source = induceSkillCatalogOutage.toString();
    expect(source).toMatch(/platform_skills/);
    expect(source).toMatch(/revision/);
    expect(restoreSkillCatalogOutage.toString()).toMatch(/DELETE FROM platform_skills/);
  });

  it('artifact counter hard-fails on query errors (no swallowed catch)', () => {
    const source = countUserSkillArtifacts.toString();
    expect(source).toMatch(/agent_skills/);
    expect(source).toMatch(/documents/);
    // Must not soft-return 0 on documents failure
    expect(source).not.toMatch(/\.catch\(\s*\(\)\s*=>/);
    expect(source).not.toMatch(/rows:\s*\[\s*\{\s*count:\s*0/);
  });
});
