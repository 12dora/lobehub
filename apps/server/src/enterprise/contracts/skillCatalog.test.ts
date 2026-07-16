import { describe, expect, it } from 'vitest';

import {
  adminSkillCreateVersionInputSchema,
  adminSkillListInputSchema,
  adminSkillUpdateDraftInputSchema,
  publishedSkillCatalogSchema,
  serverResolvedSkillSchema,
  skillValidationIssueSchema,
} from './skillCatalog';

const concurrency = {
  expectedDraftToken: 'a'.repeat(64),
  expectedRevision: 0,
  reason: 'create reviewed version',
};

const manifest = {
  description: 'Search approved internal sources',
  displayName: 'Internal search',
  localizedDescriptions: {},
  localizedDisplayNames: {},
  networkAccess: false,
  skillDependencies: [{ optional: false, skillKey: 'base.search', version: '1.0.0' }],
  toolDependencies: [{ optional: false, toolKey: 'builtin.search' }],
};

describe('Skill catalog contracts', () => {
  it('keeps identity draft edits separate from immutable versions', () => {
    expect(
      adminSkillUpdateDraftInputSchema.parse({
        ...concurrency,
        displayName: 'Renamed skill',
        id: 'skill-1',
      }),
    ).toMatchObject({ displayName: 'Renamed skill', id: 'skill-1' });

    for (const immutableField of ['checksum', 'content', 'manifest', 'version', 'versionId']) {
      expect(
        adminSkillUpdateDraftInputSchema.safeParse({
          ...concurrency,
          [immutableField]: immutableField === 'manifest' ? manifest : 'forbidden',
          id: 'skill-1',
        }).success,
      ).toBe(false);
    }
  });

  it('requires a checksummed semantic version and explicit dependencies when creating a version', () => {
    const input = {
      ...concurrency,
      checksum: 'b'.repeat(64),
      content: '# Internal search',
      contentRef: null,
      manifest,
      skillId: 'skill-1',
      version: '1.2.0',
    };
    expect(adminSkillCreateVersionInputSchema.parse(input)).toEqual(input);
    expect(
      adminSkillCreateVersionInputSchema.safeParse({ ...input, version: 'latest' }).success,
    ).toBe(false);
    expect(
      adminSkillCreateVersionInputSchema.safeParse({ ...input, checksum: 'not-sha256' }).success,
    ).toBe(false);
    expect(
      adminSkillCreateVersionInputSchema.safeParse({
        ...input,
        manifest: { ...manifest, toolDependencies: [{ toolKey: 'x', unexpected: true }] },
      }).success,
    ).toBe(false);
  });

  it('uses stable validation codes, severities and structured paths', () => {
    expect(
      skillValidationIssueSchema.parse({
        code: 'unknown_tool_dependency',
        message: 'Unknown tool',
        path: ['manifest', 'toolDependencies', 0, 'toolKey'],
        severity: 'error',
      }),
    ).toMatchObject({ code: 'unknown_tool_dependency', severity: 'error' });
    expect(
      skillValidationIssueSchema.safeParse({
        code: 'free-form-code',
        message: 'Unknown tool',
        path: [],
        severity: 'critical',
      }).success,
    ).toBe(false);
  });

  it('bounds cursors and rejects unknown list filters', () => {
    expect(adminSkillListInputSchema.parse({ cursor: 'cursor', limit: 100 })).toMatchObject({
      cursor: 'cursor',
      limit: 100,
    });
    expect(adminSkillListInputSchema.safeParse({ cursor: 'x'.repeat(1001) }).success).toBe(false);
    expect(adminSkillListInputSchema.safeParse({ ownedByUser: true }).success).toBe(false);
  });

  it('keeps public catalog free of server-only identifiers and content references', () => {
    const published = {
      checksum: 'c'.repeat(64),
      content: '# Internal search',
      description: 'Search approved internal sources',
      displayName: 'Internal search',
      distribution: 'default',
      manifest,
      skillKey: 'internal.search',
      source: 'uploaded',
      version: '1.2.0',
    } as const;
    expect(
      publishedSkillCatalogSchema.safeParse({ revision: 'revision-1', skills: [published] })
        .success,
    ).toBe(true);
    expect(
      publishedSkillCatalogSchema.safeParse({
        revision: 'revision-1',
        skills: [{ ...published, contentRef: 's3://private/object', versionId: 'version-1' }],
      }).success,
    ).toBe(false);
    expect(
      serverResolvedSkillSchema.safeParse({
        ...published,
        contentRef: 's3://private/object',
        skillId: 'skill-1',
        versionId: 'version-1',
      }).success,
    ).toBe(true);
  });
});
