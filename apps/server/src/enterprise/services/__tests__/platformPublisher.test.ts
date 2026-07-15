// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { createBrandingPointerAdapter } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformBranding,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  InMemoryPlatformConfigInvalidationPublisher,
  PlatformPublisherService,
  PlatformRevisionConflictError,
} from '../index';

const serverDB: LobeChatDatabase = await getTestDB();
const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
const publisher = new PlatformPublisherService(serverDB, invalidation);

let brandingId: string;

beforeEach(async () => {
  invalidation.events.length = 0;
  invalidation.versions.clear();
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(platformBranding);

  const [row] = await serverDB
    .insert(platformBranding)
    .values({ displayName: 'AIHub', revision: 0, status: 'draft' })
    .returning();
  brandingId = row.id;
});

afterEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(platformBranding);
});

describe('PlatformPublisherService', () => {
  it('publishes a draft and emits a config invalidation event', async () => {
    const result = await publisher.publish({
      actorUserId: 'admin-1',
      expectedRevision: 0,
      invalidationScopes: ['branding'],
      payload: { displayName: 'AIHub Corp' },
      pointer: createBrandingPointerAdapter(brandingId),
      reason: 'go-live',
      resourceId: brandingId,
      resourceType: 'branding',
    });

    expect(result.revision.revision).toBe(1);
    expect(result.revision.status).toBe('published');
    expect(invalidation.events).toHaveLength(1);
    expect(invalidation.events[0]).toMatchObject({
      resourceId: brandingId,
      resourceType: 'branding',
      revision: 1,
      scopes: ['branding'],
    });
    expect(invalidation.versions.get(`branding:${brandingId}`)).toBe(1);

    const snapshot = await publisher.getPublishedSnapshot('branding', brandingId);
    expect(snapshot?.payload).toMatchObject({ displayName: 'AIHub Corp' });
  });

  it('does not emit invalidation when publish conflicts', async () => {
    await publisher.publish({
      expectedRevision: 0,
      payload: { displayName: 'v1' },
      pointer: createBrandingPointerAdapter(brandingId),
      resourceId: brandingId,
      resourceType: 'branding',
    });
    invalidation.events.length = 0;

    await expect(
      publisher.publish({
        expectedRevision: 0,
        payload: { displayName: 'stale' },
        pointer: createBrandingPointerAdapter(brandingId),
        resourceId: brandingId,
        resourceType: 'branding',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    expect(invalidation.events).toHaveLength(0);
  });

  it('rolls back to a prior revision and invalidates caches', async () => {
    const pointer = createBrandingPointerAdapter(brandingId);
    await publisher.publish({
      expectedRevision: 0,
      payload: { displayName: 'v1' },
      pointer,
      resourceId: brandingId,
      resourceType: 'branding',
    });
    await publisher.publish({
      expectedRevision: 1,
      payload: { displayName: 'v2' },
      pointer,
      resourceId: brandingId,
      resourceType: 'branding',
    });
    invalidation.events.length = 0;

    const rolled = await publisher.rollback({
      expectedRevision: 2,
      pointer,
      reason: 'rollback bad release',
      resourceId: brandingId,
      resourceType: 'branding',
      targetRevision: 1,
    });

    expect(rolled.revision.revision).toBe(3);
    expect(rolled.revision.payload).toMatchObject({ displayName: 'v1' });
    expect(invalidation.events).toHaveLength(1);
    expect(invalidation.events[0].revision).toBe(3);
  });
});
