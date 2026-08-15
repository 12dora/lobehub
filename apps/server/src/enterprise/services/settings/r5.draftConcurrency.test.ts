// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload, PlatformSettingsModel } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  InMemoryPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import { AdminSettingsService, PlatformRevisionConflictError } from './adminSettingsService';

const serverDB: LobeChatDatabase = await getTestDB();

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const draft = (fontSize: number) => ({
  'general.fontSize': {
    mode: 'default' as const,
    schemaVersion: 1,
    value: fontSize,
    visibility: 'visible' as const,
  },
});

/** TRUNCATE bypasses append-only audit/revision immutability triggers (migration 0145). */
const clearState = async () => {
  await serverDB.execute(
    sql.raw(`
      TRUNCATE TABLE
        platform_audit_logs,
        platform_resource_revisions,
        user_setting_overrides,
        user_setting_override_revisions,
        platform_setting_policies,
        platform_settings_bundle
      CASCADE
    `),
  );
};

beforeEach(clearState);
afterEach(clearState);

describe('R5 settings draft CAS at the de-drafted save lock', () => {
  it('de-drafted save-vs-save CAS commits exactly one revision', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const materialized = deferred();
    const releaseFirst = deferred();
    const first = new AdminSettingsService(serverDB, {
      invalidation,
      lifecycle: {
        afterMaterialization: async () => {
          materialized.resolve();
          await releaseFirst.promise;
        },
      },
    });
    const second = new AdminSettingsService(serverDB, { invalidation });
    const base = await first.getDraft();

    const firstSave = first.save({
      actorUserId: 'first-admin',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: draft(18),
      reason: 'first save',
    });
    await materialized.promise;
    const secondSave = second.save({
      actorUserId: 'second-admin',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: draft(20),
      reason: 'save on a stale base',
    });
    releaseFirst.resolve();

    await expect(firstSave).resolves.toMatchObject({ revision: 1 });
    await expect(secondSave).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const model = new PlatformSettingsModel(serverDB);
    const [bundle, revisions, policy, audits] = await Promise.all([
      model.getBundle(),
      serverDB.select().from(platformResourceRevisions),
      model.getPublishedPolicy('general.fontSize'),
      serverDB.select().from(platformAuditLogs),
    ]);
    expect(bundle?.revision).toBe(1);
    // Draft column is aligned to the winner, so the loser's payload leaves no residue.
    expect(bundle?.draft).toEqual(draft(18));
    expect(revisions).toHaveLength(1);
    expect(policy?.value).toBe(18);
    expect(invalidation.events).toHaveLength(1);
    expect(
      audits
        .filter((row) => row.action === 'admin.settings.save')
        .map((row) => [row.actorUserId, row.result]),
    ).toEqual([
      ['first-admin', 'success'],
      ['second-admin', 'failure'],
    ]);
  });

  it('de-drafted save answers with its own revision/token pair when a later save commits first', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const committed = deferred();
    const releaseFirst = deferred();
    // The publisher emits invalidation AFTER COMMIT and before `save` builds its response —
    // exactly the window where an unlocked post-commit read would observe someone else's write.
    const gatedInvalidation: PlatformConfigInvalidationPublisher = {
      publish: async (event) => {
        await invalidation.publish(event);
        if (event.revision !== 1) return;
        committed.resolve();
        await releaseFirst.promise;
      },
    };
    const first = new AdminSettingsService(serverDB, { invalidation: gatedInvalidation });
    const second = new AdminSettingsService(serverDB, { invalidation });
    const base = await first.getDraft();

    const firstSave = first.save({
      actorUserId: 'first-admin',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: draft(18),
      reason: 'first save',
    });
    await committed.promise;

    // Second admin rebases on the just-committed revision and commits while the first
    // response is still being assembled.
    const afterFirst = await second.getDraft();
    const secondResult = await second.save({
      actorUserId: 'second-admin',
      expectedDraftToken: afterFirst.draftToken,
      expectedRevision: afterFirst.baseRevision,
      policies: draft(20),
      reason: 'second save commits during the first response',
    });
    releaseFirst.resolve();
    const firstResult = await firstSave;

    expect(firstResult).toMatchObject({
      draftToken: checksumPayload({ draft: draft(18), revision: 1 }),
      revision: 1,
    });
    expect(secondResult).toMatchObject({
      draftToken: checksumPayload({ draft: draft(20), revision: 2 }),
      revision: 2,
    });
    expect(firstResult.draftToken).not.toBe(secondResult.draftToken);
    // The first pair is coherent (its own revision), therefore correctly stale now.
    await expect(
      first.save({
        actorUserId: 'first-admin',
        expectedDraftToken: firstResult.draftToken,
        expectedRevision: firstResult.revision,
        policies: draft(22),
        reason: 'replay the first CAS base',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
  });

  it('rejects a de-drafted save whose revision is current but whose draft token is stale', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const admin = new AdminSettingsService(serverDB, { invalidation });
    const base = await admin.getDraft();
    // A stranded legacy draft moves the token without moving the revision.
    await new PlatformSettingsModel(serverDB).saveDraft({
      draft: draft(18),
      updatedBy: 'seed-admin',
    });
    const current = await admin.getDraft();
    expect(current.baseRevision).toBe(base.baseRevision);
    expect(current.draftToken).not.toBe(base.draftToken);

    await expect(
      admin.save({
        actorUserId: 'save-admin',
        expectedDraftToken: base.draftToken,
        expectedRevision: current.baseRevision,
        policies: draft(20),
        reason: 'token-only stale base',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const model = new PlatformSettingsModel(serverDB);
    const [bundle, revisions, policies] = await Promise.all([
      model.getBundle(),
      serverDB.select().from(platformResourceRevisions),
      serverDB.select().from(platformSettingPolicies),
    ]);
    expect(bundle?.revision).toBe(0);
    expect(revisions).toEqual([]);
    expect(policies).toEqual([]);
    expect(invalidation.events).toEqual([]);

    // Same revision, matching token → the save goes through.
    const saved = await admin.save({
      actorUserId: 'save-admin',
      expectedDraftToken: current.draftToken,
      expectedRevision: current.baseRevision,
      policies: draft(20),
      reason: 'token-matched save',
    });
    expect(saved).toMatchObject({
      draftToken: checksumPayload({ draft: draft(20), revision: 1 }),
      revision: 1,
    });
  });
});
