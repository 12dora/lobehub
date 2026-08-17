// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const platformSource = readFileSync(path.join(here, 'platform.ts'), 'utf8');
const adminSource = readFileSync(path.join(here, 'admin.ts'), 'utf8');

describe('platform / admin import-time workers', () => {
  it('does not start workers or readiness probes at platform.ts module load (G2 re-homes)', () => {
    expect(platformSource).not.toMatch(/ensurePlatformSecretRewrapWorkerStarted\s*\(/);
    expect(platformSource).not.toMatch(/ensureBrandingAssetCleanupWorkerStarted\s*\(/);
    expect(platformSource).not.toMatch(/ensurePlatformAuditExportWorkerStarted\s*\(/);
    expect(platformSource).not.toMatch(/ensurePlatformAuditRetentionWorkerStarted\s*\(/);
    expect(platformSource).not.toMatch(/ensureNetworkProxyEngineSupervisorStarted\s*\(/);
    expect(platformSource).not.toMatch(/warnIfPlatformMasterKeyMissing\s*\(/);
  });

  it('does not register catalog readiness at admin.ts module load (G2 re-homes)', () => {
    expect(adminSource).not.toMatch(/ensureAiCatalogReadinessRegistered\s*\(/);
    expect(adminSource).not.toMatch(/ensureConnectorCatalogReadinessRegistered\s*\(/);
    expect(adminSource).not.toMatch(/ensureSkillCatalogReadinessRegistered\s*\(/);
  });
});
