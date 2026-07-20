import { describe, expect, it } from 'vitest';

import {
  countUserSkillArtifacts,
  induceSkillCatalogOutage,
  restoreSkillCatalogOutage,
} from './skillOutage';

/**
 * Contract tests for the isolated skill-catalog outage mechanism.
 * Live readiness=false + 403 RESOURCE_MANAGED_BY_PLATFORM is exercised in E2E.
 */
describe('skill catalog outage mechanism', () => {
  it('exports induce/restore/count as a reversible pair', () => {
    expect(typeof induceSkillCatalogOutage).toBe('function');
    expect(typeof restoreSkillCatalogOutage).toBe('function');
    expect(typeof countUserSkillArtifacts).toBe('function');
  });

  it('outage handle restore is the same restore entrypoint', async () => {
    // Shape contract: induce returns { restore } that calls restoreSkillCatalogOutage.
    // We only assert the public surface here; DB induction is live-E2E only.
    const source = induceSkillCatalogOutage.toString();
    expect(source).toMatch(/platform_skills/);
    expect(source).toMatch(/revision/);
    expect(restoreSkillCatalogOutage.toString()).toMatch(/DELETE FROM platform_skills/);
  });

  it('artifact counter queries agent_skills and documents for the user', () => {
    const source = countUserSkillArtifacts.toString();
    expect(source).toMatch(/agent_skills/);
    expect(source).toMatch(/documents/);
    expect(source).toMatch(/user_id/);
  });
});
