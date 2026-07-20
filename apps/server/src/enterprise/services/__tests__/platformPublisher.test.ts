// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { createBrandingPointerAdapter } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformBranding,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { EnterpriseObservabilityEvent } from '../../observability';
import {
  NOOP_ENTERPRISE_STRUCTURED_LOGGER,
  setEnterprisePlatformObserverForTest,
  setEnterpriseStructuredLoggerForTest,
} from '../../observability';
import {
  InMemoryPlatformConfigInvalidationPublisher,
  PlatformPublisherService,
  PlatformRevisionConflictError,
} from '../index';

const serverDB: LobeChatDatabase = await getTestDB();
const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
const publisher = new PlatformPublisherService(serverDB, invalidation);

let brandingId: string;
let observations: EnterpriseObservabilityEvent[];

beforeEach(async () => {
  observations = [];
  setEnterprisePlatformObserverForTest({ record: (event) => observations.push(event) });
  setEnterpriseStructuredLoggerForTest(NOOP_ENTERPRISE_STRUCTURED_LOGGER);
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
  setEnterprisePlatformObserverForTest(null);
  setEnterpriseStructuredLoggerForTest(null);
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
    expect(observations).toContainEqual(
      expect.objectContaining({
        domain: 'branding',
        operation: 'publish',
        outcome: 'success',
        type: 'config_publish',
      }),
    );

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
    expect(observations).toContainEqual(
      expect.objectContaining({
        domain: 'branding',
        errorClass: 'ConflictError',
        operation: 'publish',
        outcome: 'conflict',
        type: 'config_publish',
      }),
    );
  });

  it('returns committed success when best-effort invalidation delivery fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingPublisher = new PlatformPublisherService(serverDB, {
      publish: async () => {
        throw new Error('redis unavailable');
      },
    });

    const result = await failingPublisher.publish({
      actorUserId: 'admin-1',
      expectedRevision: 0,
      payload: { displayName: 'committed' },
      pointer: createBrandingPointerAdapter(brandingId),
      resourceId: brandingId,
      resourceType: 'branding',
    });

    expect(result.revision.revision).toBe(1);
    expect(await serverDB.select().from(platformResourceRevisions)).toHaveLength(1);
    expect(await serverDB.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ result: 'success' }),
    );
    expect(error).toHaveBeenCalledWith(
      '[platformPublisher] invalidation delivery failed',
      expect.objectContaining({ revision: 1 }),
    );
    error.mockRestore();
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
    expect(observations).toContainEqual(
      expect.objectContaining({
        domain: 'branding',
        operation: 'rollback',
        outcome: 'success',
        type: 'config_publish',
      }),
    );
  });

  it('classifies non-conflict publish failures without exposing resource ids', async () => {
    const rawResourceId = 'raw-branding-resource-id';
    await expect(
      publisher.publish({
        expectedRevision: 0,
        payload: { displayName: 'failure' },
        pointer: {
          lockAndGetRevision: async () => {
            throw new TypeError('raw database detail');
          },
          updatePointer: async () => {},
        },
        resourceId: rawResourceId,
        resourceType: 'branding',
      }),
    ).rejects.toThrow('raw database detail');

    const event = observations.find(
      ({ type, outcome }) => type === 'config_publish' && outcome === 'failure',
    );
    expect(event).toMatchObject({
      domain: 'branding',
      errorClass: 'UnexpectedError',
      operation: 'publish',
      type: 'config_publish',
    });
    expect(JSON.stringify(event)).not.toContain(rawResourceId);
    expect(JSON.stringify(event)).not.toContain('database detail');
  });

  it('keeps a committed publish successful when the observability sink fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    setEnterprisePlatformObserverForTest({
      record: () => {
        throw new Error('raw sink detail');
      },
    });

    await expect(
      publisher.publish({
        expectedRevision: 0,
        payload: { displayName: 'observed' },
        pointer: createBrandingPointerAdapter(brandingId),
        resourceId: brandingId,
        resourceType: 'branding',
      }),
    ).resolves.toMatchObject({ revision: { revision: 1 } });
    expect(await serverDB.select().from(platformResourceRevisions)).toHaveLength(1);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('raw sink detail');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(brandingId);
    consoleError.mockRestore();
  });

  it('classifies rollback conflicts and failures while preserving the original errors', async () => {
    const pointer = createBrandingPointerAdapter(brandingId);
    await publisher.publish({
      expectedRevision: 0,
      payload: { displayName: 'v1' },
      pointer,
      resourceId: brandingId,
      resourceType: 'branding',
    });
    observations.length = 0;

    await expect(
      publisher.rollback({
        expectedRevision: 0,
        pointer,
        resourceId: brandingId,
        resourceType: 'branding',
        targetRevision: 1,
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    const rawFailure = new TypeError('raw rollback database detail');
    await expect(
      publisher.rollback({
        expectedRevision: 1,
        pointer: {
          lockAndGetRevision: async () => {
            throw rawFailure;
          },
          updatePointer: async () => {},
        },
        resourceId: brandingId,
        resourceType: 'branding',
        targetRevision: 1,
      }),
    ).rejects.toBe(rawFailure);

    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'rollback', outcome: 'conflict' }),
        expect.objectContaining({ operation: 'rollback', outcome: 'failure' }),
      ]),
    );
    expect(JSON.stringify(observations)).not.toContain(brandingId);
    expect(JSON.stringify(observations)).not.toContain('database detail');
  });
});
