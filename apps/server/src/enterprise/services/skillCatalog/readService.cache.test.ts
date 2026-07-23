// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { loadCurrentSkillCatalogSnapshot } from '../platformInstance/catalogAuthority';
import type { PlatformRuntimeMaterializationReporter } from '../platformInstance/runtimeReporter';
import { invalidatePublishedSkillCatalogReadCache, SkillCatalogReadService } from './readService';
import {
  db,
  deferred,
  installReadServiceTestLifecycle,
  publishReadServiceSkill as publish,
} from './readService.test.fixtures';

installReadServiceTestLifecycle();

describe('SkillCatalogReadService cache / single-flight', () => {
  it('reuses the revision projection until explicit publication invalidation', async () => {
    await publish({ skillKey: 'cached.skill', version: '1.0.0' });
    const loadCurrentSnapshot = vi.fn(() => loadCurrentSkillCatalogSnapshot(db));

    const first = new SkillCatalogReadService(db, { loadCurrentSnapshot });
    const second = new SkillCatalogReadService(db, { loadCurrentSnapshot });
    const firstCatalog = await first.getPublishedCatalog();
    const secondCatalog = await second.getPublishedCatalog();
    expect(secondCatalog).toEqual(firstCatalog);
    expect(loadCurrentSnapshot).toHaveBeenCalledTimes(1);

    invalidatePublishedSkillCatalogReadCache();
    await new SkillCatalogReadService(db, { loadCurrentSnapshot }).getPublishedCatalog();
    expect(loadCurrentSnapshot).toHaveBeenCalledTimes(2);
  });
  it('coalesces a runtime cold load and ignores an old-epoch late failure', async () => {
    await publish({ contentRef: null, skillKey: 'singleflight.skill', version: '1.0.0' });
    const snapshot = await loadCurrentSkillCatalogSnapshot(db);
    const oldRead = deferred<typeof snapshot>();
    const newRead = deferred<typeof snapshot>();
    const loadCurrentSnapshot = vi
      .fn<() => Promise<typeof snapshot>>()
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(newRead.promise);
    let epoch = 'old';
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const service = new SkillCatalogReadService(db, {
      getCacheEpoch: async () => epoch,
      loadCurrentSnapshot,
      runtimeReporting: { database: db, reporter: reportRuntimeState },
    });

    const oldRequest = service.getPublishedCatalog();
    const coalesced = service.getPublishedCatalog();
    await vi.waitFor(() => expect(loadCurrentSnapshot).toHaveBeenCalledOnce());
    epoch = 'new';
    const currentRequest = service.getPublishedCatalog();
    await vi.waitFor(() => expect(loadCurrentSnapshot).toHaveBeenCalledTimes(2));
    newRead.resolve(snapshot);
    await expect(currentRequest).resolves.toMatchObject({
      skills: [expect.objectContaining({ skillKey: 'singleflight.skill' })],
    });

    const oldError = new Error('late old Skill catalog failure');
    const oldResults = Promise.all([
      expect(oldRequest).rejects.toBe(oldError),
      expect(coalesced).rejects.toBe(oldError),
    ]);
    oldRead.reject(oldError);
    await oldResults;

    expect(reportRuntimeState.mock.calls.map(([, state]) => state.health)).toEqual(['healthy']);
    await expect(service.getPublishedCatalog()).resolves.toMatchObject({
      skills: [expect.objectContaining({ skillKey: 'singleflight.skill' })],
    });
    expect(loadCurrentSnapshot).toHaveBeenCalledTimes(2);
  });
  it('invalidates a warm projection on another instance through the shared epoch', async () => {
    const { skill } = await publish({ skillKey: 'cross-instance.skill', version: '1.0.0' });
    const loadCurrentSnapshot = vi.fn(() => loadCurrentSkillCatalogSnapshot(db));
    let epoch = '1';
    const options = {
      cacheTtlMs: 60_000,
      getCacheEpoch: async () => epoch,
      loadCurrentSnapshot,
    };
    const firstInstance = new SkillCatalogReadService(db, options);
    await expect(firstInstance.getPublishedCatalog()).resolves.toMatchObject({
      skills: [expect.objectContaining({ version: '1.0.0' })],
    });

    await publish({
      revision: 2,
      skillId: skill.id,
      skillKey: 'cross-instance.skill',
      version: '2.0.0',
    });
    epoch = '2';
    const secondInstance = new SkillCatalogReadService(db, options);

    await expect(secondInstance.getPublishedCatalog()).resolves.toMatchObject({
      skills: [expect.objectContaining({ version: '2.0.0' })],
    });
    expect(loadCurrentSnapshot).toHaveBeenCalledTimes(2);
  });

  it('bounds a warm projection when the epoch reader is unavailable', async () => {
    await publish({ skillKey: 'ttl.skill', version: '1.0.0' });
    const loadCurrentSnapshot = vi.fn(() => loadCurrentSkillCatalogSnapshot(db));
    let now = 1_000;
    const options = {
      cacheTtlMs: 100,
      getCacheEpoch: async () => {
        throw new Error('redis unavailable');
      },
      loadCurrentSnapshot,
      now: () => now,
    };
    await new SkillCatalogReadService(db, options).getPublishedCatalog();
    await new SkillCatalogReadService(db, options).getPublishedCatalog();
    expect(loadCurrentSnapshot).toHaveBeenCalledTimes(1);

    now += 101;
    await new SkillCatalogReadService(db, options).getPublishedCatalog();
    expect(loadCurrentSnapshot).toHaveBeenCalledTimes(2);
  });
});
