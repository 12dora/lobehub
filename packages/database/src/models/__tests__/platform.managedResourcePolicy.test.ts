// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformManagedResourcePolicies } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '../platform/managedResourcePolicy';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new PlatformManagedResourcePolicyModel(serverDB);

beforeEach(async () => {
  await serverDB.delete(platformManagedResourcePolicies);
});

afterEach(async () => {
  await serverDB.delete(platformManagedResourcePolicies);
});

describe('PlatformManagedResourcePolicyModel', () => {
  it('creates exactly the five fixed policy rows with a closed snapshot', async () => {
    await model.ensureRows();
    await model.ensureRows();

    const rows = await model.listRows();
    expect(rows).toHaveLength(5);
    expect(await model.getSnapshot()).toEqual({
      draft: createUnmanagedResourcePolicyMap(),
      published: createUnmanagedResourcePolicyMap(),
      revision: 0,
      status: 'draft',
    });
    expect(await model.lockAndGetRevision()).toBe(0);
  });

  it('keeps draft out of published JSON and compatibility enforcement column', async () => {
    await model.ensureRows();
    const draft = createUnmanagedResourcePolicyMap();
    draft.aiProviders = { enforcementMode: 'enforced', managed: true };

    await model.replaceDraft({ draft, updatedBy: 'admin-1' });

    const snapshot = await model.getSnapshot();
    expect(snapshot.draft.aiProviders).toEqual(draft.aiProviders);
    expect(snapshot.published.aiProviders).toEqual({ enforcementMode: 'observe', managed: false });
    const [row] = await serverDB
      .select()
      .from(platformManagedResourcePolicies)
      .where(eq(platformManagedResourcePolicies.resource, 'aiProviders'));
    expect(row.enforcement).toBe('observe');
  });

  it('materializes one published snapshot and advances all row pointers together', async () => {
    await model.ensureRows();
    const policies = createUnmanagedResourcePolicyMap();
    policies.skills = { enforcementMode: 'ui-only', managed: true };

    await model.materializePublished({ policies, revision: 3, updatedBy: 'admin-1' });

    const snapshot = await model.getSnapshot();
    expect(snapshot).toMatchObject({ revision: 3, status: 'published' });
    expect(snapshot.draft).toEqual(policies);
    expect(snapshot.published).toEqual(policies);
    const rows = await model.listRows();
    expect(new Set(rows.map((row) => row.revision))).toEqual(new Set([3]));
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(['published']));
  });

  it('fails closed and rejects locking when row revision pointers diverge', async () => {
    await model.ensureRows();
    await serverDB
      .update(platformManagedResourcePolicies)
      .set({ revision: 2, status: 'published' })
      .where(eq(platformManagedResourcePolicies.resource, 'agents'));

    expect((await model.getSnapshot()).status).toBe('draft');
    expect((await model.getSnapshot()).revision).toBe(0);
    await expect(model.lockAndGetRevision()).rejects.toThrow('revision pointers diverged');
  });
});
