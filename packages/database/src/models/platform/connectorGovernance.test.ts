// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONNECTOR_GOVERNANCE_RESOURCE_ID } from '@/types/platform/connectorGovernance';

import { getTestDB } from '../../core/getTestDB';
import { platformConnectorGovernance } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  normalizeConnectorGovernanceDoc,
  PlatformConnectorGovernanceModel,
} from './connectorGovernance';
import { PlatformRevisionConflictError } from './errors';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformConnectorGovernance);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformConnectorGovernanceModel', () => {
  it('creates the single logical row on first read and normalizes legacy empty config', async () => {
    const model = new PlatformConnectorGovernanceModel(db);
    const snapshot = await model.getOrCreate();

    expect(snapshot).toEqual({
      draft: { builtinToolPolicies: {}, sharedAuthorization: { ownerUserId: null } },
      published: { builtinToolPolicies: {}, sharedAuthorization: { ownerUserId: null } },
      revision: 0,
    });

    // Legacy `{}` config rows are closed to the empty doc without mutation.
    await db.delete(platformConnectorGovernance);
    await db.insert(platformConnectorGovernance).values({
      config: {} as never,
      resource: CONNECTOR_GOVERNANCE_RESOURCE_ID,
      revision: 3,
    });
    const legacy = await model.getOrCreate();
    expect(legacy.published).toEqual({
      builtinToolPolicies: {},
      sharedAuthorization: { ownerUserId: null },
    });
    expect(legacy.revision).toBe(3);
  });

  it('publishes draft+published together and bumps the revision', async () => {
    const model = new PlatformConnectorGovernanceModel(db);
    const doc = {
      builtinToolPolicies: { 'lobe-task': { createTask: 'needs_approval' as const } },
      sharedAuthorization: { ownerUserId: 'owner-user' },
    };

    await expect(
      model.publishGovernance({ doc, expectedRevision: 0, updatedBy: 'admin-user' }),
    ).resolves.toEqual({ revision: 1 });

    const snapshot = await model.getOrCreate();
    expect(snapshot).toEqual({ draft: doc, published: doc, revision: 1 });

    const [row] = await db.select().from(platformConnectorGovernance);
    expect(row.updatedBy).toBe('admin-user');
    expect(row.resource).toBe(CONNECTOR_GOVERNANCE_RESOURCE_ID);
  });

  it('rejects publish with a typed conflict when expectedRevision does not match', async () => {
    const model = new PlatformConnectorGovernanceModel(db);
    await model.publishGovernance({
      doc: {
        builtinToolPolicies: {},
        sharedAuthorization: { ownerUserId: null },
      },
      expectedRevision: 0,
    });

    await expect(
      model.publishGovernance({
        doc: { builtinToolPolicies: {}, sharedAuthorization: { ownerUserId: 'someone' } },
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    // Losing writer changed nothing.
    const snapshot = await model.getOrCreate();
    expect(snapshot.revision).toBe(1);
    expect(snapshot.published.sharedAuthorization.ownerUserId).toBeNull();
  });

  it('normalizes malformed docs on write and read', async () => {
    expect(
      normalizeConnectorGovernanceDoc({
        builtinToolPolicies: {
          'lobe-task': { bad: 'allow', good: 'auto' },
          'broken': 'not-an-object',
        },
        sharedAuthorization: { ownerUserId: '' },
      }),
    ).toEqual({
      builtinToolPolicies: { 'lobe-task': { good: 'auto' } },
      sharedAuthorization: { ownerUserId: null },
    });
    expect(normalizeConnectorGovernanceDoc(null)).toEqual({
      builtinToolPolicies: {},
      sharedAuthorization: { ownerUserId: null },
    });
  });
});
