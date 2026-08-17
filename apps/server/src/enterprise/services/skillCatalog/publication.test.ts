// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { SkillCatalogNotFoundError } from './errors';
import { SkillCatalogPublicationService } from './publication';

const mocks = vi.hoisted(() => ({
  appendAudit: vi.fn(),
  getPublishedRevisionForVersion: vi.fn(),
  getSkill: vi.fn(),
  getVersion: vi.fn(),
  publish: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock('@/database/repositories/platformSkillCatalog', () => ({
  PlatformSkillCatalogRepository: class {
    getPublishedRevisionForVersion = mocks.getPublishedRevisionForVersion;
    getSkill = mocks.getSkill;
    getVersion = mocks.getVersion;
  },
}));

vi.mock('../platformAudit', () => ({
  PlatformAuditService: class {
    append = mocks.appendAudit;
  },
}));

vi.mock('../platformPublisher', () => ({
  PlatformPublisherService: class {
    publish = mocks.publish;
    rollback = mocks.rollback;
  },
}));

vi.mock('./validationService', () => ({
  SkillCatalogValidationService: class {},
}));

vi.mock('./readService', () => ({
  invalidatePublishedSkillCatalogReadCache: vi.fn(),
}));

vi.mock('../platformInstance/catalogTokens', () => ({
  invalidateSkillCatalogAuthorityToken: vi.fn(),
  onAiCatalogAuthorityInvalidate: vi.fn(() => () => {}),
}));

const db = {} as LobeChatDatabase;

describe('SkillCatalogPublicationService failure audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      action: 'admin.skills.publish' as const,
      invoke: (service: SkillCatalogPublicationService) =>
        service.publish('admin-1', {
          expectedDraftToken: 'token',
          expectedRevision: 1,
          id: 'skill-1',
          reason: 'publish',
          versionId: 'version-1',
        }),
      setup: () => {
        mocks.getVersion.mockResolvedValue(null);
      },
    },
    {
      action: 'admin.skills.archive' as const,
      invoke: (service: SkillCatalogPublicationService) =>
        service.archive('admin-1', {
          expectedDraftToken: 'token',
          expectedRevision: 1,
          id: 'skill-1',
          reason: 'archive',
        }),
      setup: () => {
        mocks.getSkill.mockResolvedValue(null);
      },
    },
    {
      action: 'admin.skills.rollback' as const,
      invoke: (service: SkillCatalogPublicationService) =>
        service.rollback('admin-1', {
          expectedDraftToken: 'token',
          expectedRevision: 1,
          id: 'skill-1',
          reason: 'rollback',
          targetVersionId: 'version-1',
        }),
      setup: () => {
        mocks.getPublishedRevisionForVersion.mockResolvedValue(null);
      },
    },
  ])(
    'preserves the primary $action error when failure-audit append also rejects',
    async ({ action, invoke, setup }) => {
      setup();
      const primary = new SkillCatalogNotFoundError();
      // getVersion/getSkill/getPublishedRevisionForVersion returning null throws NotFound;
      // force-audit path still runs after that rejection.
      mocks.appendAudit.mockRejectedValue(new Error('audit driver unavailable'));

      const service = new SkillCatalogPublicationService(db);
      await expect(invoke(service)).rejects.toBeInstanceOf(SkillCatalogNotFoundError);
      await expect(invoke(service)).rejects.toMatchObject({ name: primary.name });
      expect(mocks.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action, result: 'failure', targetId: 'skill-1' }),
      );
    },
  );

  it('rethrows the same primary error object identity when audit fails on publish', async () => {
    const primary = new SkillCatalogNotFoundError();
    mocks.getVersion.mockRejectedValue(primary);
    mocks.appendAudit.mockRejectedValue(new Error('audit driver unavailable'));

    const service = new SkillCatalogPublicationService(db);
    await expect(
      service.publish('admin-1', {
        expectedDraftToken: 'token',
        expectedRevision: 1,
        id: 'skill-1',
        reason: 'publish',
        versionId: 'version-1',
      }),
    ).rejects.toBe(primary);
  });
});
