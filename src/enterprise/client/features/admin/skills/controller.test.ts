import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import {
  buildSkillUpdatePayload,
  buildSkillVersionPayload,
  deriveSkillPermissions,
  type EditableSkillDraft,
  parseEditableSkillVersionDraft,
  rebaseSkillDraft,
  resolveSkillPrimaryAction,
  summarizeSkillValidation,
  toEditableSkillDraft,
} from './controller';
import type { AdminSkillGetOutput, AdminSkillValidateOutput } from './types';

const manifest = {
  description: 'Safe Skill',
  displayName: 'Safe Skill',
  localizedDescriptions: {},
  localizedDisplayNames: {},
  permissions: {
    filesystem: 'none' as const,
    network: { allowedHosts: [], enabled: false },
    tools: { allow: [] },
  },
  skillDependencies: [],
  toolDependencies: [],
};

const snapshot = (): AdminSkillGetOutput => ({
  baseRevision: 3,
  draft: {
    allowBuiltinOverride: false,
    currentVersionId: 'version-1',
    description: 'Safe description',
    displayName: 'Safe Skill',
    distribution: 'default',
    draftSequence: 2,
    enabled: true,
    id: 'skill-1',
    revision: 3,
    skillKey: 'safe.skill',
    source: 'uploaded',
    status: 'draft',
  },
  draftToken: 'a'.repeat(64),
  latestVersion: {
    checksum: 'b'.repeat(64),
    createdAt: new Date('2026-07-17T00:00:00Z'),
    createdBy: 'admin-1',
    id: 'version-1',
    lastPublishedRevision: null,
    skillId: 'skill-1',
    validation: null,
    version: '1.0.0',
  },
  publishedVersion: null,
});

describe('M08 Skill UI controller', () => {
  it('derives granular read/create/update/publish/archive capabilities', () => {
    expect(deriveSkillPermissions([PLATFORM_PERMISSIONS.SKILL_READ])).toEqual({
      canArchive: false,
      canCreate: false,
      canPublish: false,
      canRead: true,
      canUpdate: false,
    });
    expect(
      deriveSkillPermissions([
        PLATFORM_PERMISSIONS.SKILL_CREATE,
        PLATFORM_PERMISSIONS.SKILL_DELETE,
        PLATFORM_PERMISSIONS.SKILL_PUBLISH,
        PLATFORM_PERMISSIONS.SKILL_UPDATE,
      ]),
    ).toMatchObject({
      canArchive: true,
      canCreate: true,
      canPublish: true,
      canUpdate: true,
    });
  });

  it('builds CAS-bound identity and version payloads without a client checksum', () => {
    const editable = toEditableSkillDraft(snapshot());
    expect(
      buildSkillUpdatePayload({
        draft: { ...editable.identity, description: ' updated ' },
        draftToken: 'a'.repeat(64),
        id: 'skill-1',
        reason: ' reviewed update ',
        revision: 3,
      }),
    ).toMatchObject({
      description: 'updated',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 3,
      reason: 'reviewed update',
    });

    const versionPayload = buildSkillVersionPayload({
      draft: {
        content: '# Safe content',
        contentRef: '',
        manifestText: JSON.stringify(manifest),
        resourcesText: '[]',
        version: '1.1.0',
      },
      draftToken: 'a'.repeat(64),
      reason: 'reviewed immutable version',
      revision: 3,
      skillId: 'skill-1',
    });
    expect(versionPayload).toMatchObject({
      contentRef: null,
      expectedRevision: 3,
      skillId: 'skill-1',
      version: '1.1.0',
    });
    expect(versionPayload).not.toHaveProperty('checksum');
  });

  it('keeps invalid manifest/resources input available while refusing a mutation payload', () => {
    const draft = {
      content: '# Safe content',
      contentRef: '',
      manifestText: '{invalid',
      resourcesText: '{}',
      version: '1.0.0',
    };
    expect(parseEditableSkillVersionDraft(draft)).toMatchObject({
      manifestError: true,
      resourcesError: true,
      valid: false,
    });
    expect(
      buildSkillVersionPayload({
        draft,
        draftToken: 'a'.repeat(64),
        reason: 'reviewed',
        revision: 3,
        skillId: 'skill-1',
      }),
    ).toBeNull();
  });

  it('three-way rebases identity fields while preserving the local version draft', () => {
    const original = toEditableSkillDraft(snapshot());
    const local: EditableSkillDraft = {
      identity: { ...original.identity, displayName: 'Local name', enabled: false },
      versionDraft: {
        content: '# Local version',
        contentRef: '',
        manifestText: JSON.stringify(manifest),
        resourcesText: '[]',
        version: '2.0.0',
      },
    };
    const latest: EditableSkillDraft = {
      identity: {
        ...original.identity,
        description: 'Server description',
        displayName: 'Server name',
      },
      versionDraft: null,
    };
    const rebased = rebaseSkillDraft({ latest, local, original });
    expect(rebased.draft.identity).toEqual({
      description: 'Server description',
      displayName: 'Local name',
      distribution: 'default',
      enabled: false,
    });
    expect(rebased.draft.versionDraft?.content).toBe('# Local version');
    expect(rebased.conflicts).toEqual([
      expect.objectContaining({ field: 'displayName', latest: 'Server name', local: 'Local name' }),
    ]);
  });

  it('prioritizes retry/save/validate/publish and blocks actions during conflict', () => {
    const valid: AdminSkillValidateOutput = {
      issues: [],
      validatedAt: new Date(),
      validatorVersion: 'm08-v2',
    };
    expect(summarizeSkillValidation(valid)).toEqual({ errors: 0, publishable: true, warnings: 0 });
    expect(
      resolveSkillPrimaryAction({
        canPublish: true,
        canSave: true,
        canValidate: true,
        conflict: true,
        dirty: true,
        hasVersion: true,
        saveState: 'dirty',
        validation: valid,
      }),
    ).toBe('none');
    expect(
      resolveSkillPrimaryAction({
        canPublish: true,
        canSave: true,
        canValidate: true,
        conflict: false,
        dirty: false,
        hasVersion: true,
        saveState: 'failed',
        validation: valid,
      }),
    ).toBe('retry');
    expect(
      resolveSkillPrimaryAction({
        canPublish: true,
        canSave: true,
        canValidate: true,
        conflict: false,
        dirty: false,
        hasVersion: true,
        saveState: 'saved',
        validation: valid,
      }),
    ).toBe('publish');
  });
});
