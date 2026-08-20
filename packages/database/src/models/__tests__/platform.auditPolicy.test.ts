// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { PLATFORM_AUDIT_POLICY_ID, platformAuditPolicies } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAuditPolicyModel } from '../platform/auditPolicy';
import { PlatformRevisionConflictError } from '../platform/errors';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new PlatformAuditPolicyModel(serverDB);

afterEach(async () => {
  await serverDB.delete(platformAuditPolicies);
});

describe('PlatformAuditPolicyModel', () => {
  describe('getOrCreate', () => {
    it('materializes the global singleton with safe defaults matching schema', async () => {
      const policy = await model.getOrCreate();

      expect(policy.id).toBe(PLATFORM_AUDIT_POLICY_ID);
      expect(policy.revision).toBe(0);
      expect(policy.contentAccessMode).toBe('metadata_only');
      expect(policy.messageBodyInExport).toBe(false);
      expect(policy.redactionProfile).toBe('strict');
      // schema defaults: op logs 365d, conversations 180d, export artifacts 7d, max rows 50_000
      expect(policy.operationLogRetentionDays).toBe(365);
      expect(policy.conversationRetentionDays).toBe(180);
      expect(policy.exportArtifactRetentionDays).toBe(7);
      expect(policy.maxExportRows).toBe(50_000);
      expect(policy.maxListWindowDays).toBe(90);
    });

    it('is idempotent under concurrent ensure semantics', async () => {
      const first = await model.getOrCreate();
      const second = await model.getOrCreate();
      expect(second).toEqual(first);

      const rows = await serverDB.select().from(platformAuditPolicies);
      expect(rows).toHaveLength(1);
    });
  });

  describe('updateCAS', () => {
    it('updates fields and bumps revision when expectedRevision matches', async () => {
      const created = await model.getOrCreate();

      const updated = await model.updateCAS({
        contentAccessMode: 'content_allowed',
        expectedRevision: created.revision,
        messageBodyInExport: true,
        operationLogRetentionDays: 30,
        redactionProfile: 'standard',
        updatedBy: 'admin-1',
      });

      expect(updated.revision).toBe(1);
      expect(updated.contentAccessMode).toBe('content_allowed');
      expect(updated.messageBodyInExport).toBe(true);
      expect(updated.operationLogRetentionDays).toBe(30);
      expect(updated.redactionProfile).toBe('standard');
      expect(updated.updatedBy).toBe('admin-1');
    });

    it('accepts redactionProfile off via CAS (CHECK admits off; default remains strict)', async () => {
      const created = await model.getOrCreate();
      expect(created.redactionProfile).toBe('strict');

      const updated = await model.updateCAS({
        expectedRevision: created.revision,
        redactionProfile: 'off',
      });

      expect(updated.redactionProfile).toBe('off');
      expect(updated.revision).toBe(created.revision + 1);
    });

    it('throws PlatformRevisionConflictError on stale expectedRevision', async () => {
      const created = await model.getOrCreate();
      await model.updateCAS({
        expectedRevision: created.revision,
        maxListWindowDays: 14,
        updatedBy: 'admin-1',
      });

      await expect(
        model.updateCAS({
          expectedRevision: created.revision,
          maxListWindowDays: 7,
          updatedBy: 'admin-2',
        }),
      ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

      const current = await model.getOrCreate();
      expect(current.revision).toBe(1);
      expect(current.maxListWindowDays).toBe(14);
      expect(current.updatedBy).toBe('admin-1');
    });

    it('does not apply partial fields omitted from the CAS patch', async () => {
      const created = await model.getOrCreate();
      await model.updateCAS({
        expectedRevision: created.revision,
        maxExportRows: 5000,
      });
      const after = await model.getOrCreate();
      expect(after.maxExportRows).toBe(5000);
      expect(after.contentAccessMode).toBe('metadata_only');
    });
  });
});
