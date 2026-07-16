import { describe, expect, it } from 'vitest';

import {
  adminSkillArchiveInputSchema,
  adminSkillCreateInputSchema,
  adminSkillCreateVersionInputSchema,
  adminSkillCreateVersionOutputSchema,
  adminSkillGetDependentsInputSchema,
  adminSkillGetDependentsOutputSchema,
  adminSkillListInputSchema,
  adminSkillPublicationOutputSchema,
  adminSkillUpdateDraftInputSchema,
  adminSkillValidateOutputSchema,
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
  permissions: {
    filesystem: 'none',
    network: { allowedHosts: [], enabled: false },
    tools: { allow: ['builtin.search'] },
  },
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

  it('uses complete SemVer validation instead of a permissive regex', () => {
    const input = {
      ...concurrency,
      checksum: 'b'.repeat(64),
      content: '# Internal search',
      manifest,
      skillId: 'skill-1',
      version: '1.2.3-alpha.1+build.5',
    };
    expect(adminSkillCreateVersionInputSchema.safeParse(input).success).toBe(true);
    for (const version of ['01.2.3', '1.02.3', '1.2.03', '1.2.3-', '1.2.3-alpha..1']) {
      expect(adminSkillCreateVersionInputSchema.safeParse({ ...input, version }).success).toBe(
        false,
      );
    }
  });

  it('rejects secret-shaped identity, localized and reason text using enterprise redaction', () => {
    const base = { displayName: 'Safe skill', reason: 'create reviewed skill', skillKey: 'safe' };
    expect(adminSkillCreateInputSchema.safeParse(base).success).toBe(true);
    for (const patch of [
      { displayName: 'Bearer sk-fake-not-real-display' },
      { description: 'ghp_abcdefghijklmnopqrstuvwxyz123456' },
      { reason: 'xoxb-fake-token-in-audit-reason' },
    ]) {
      expect(adminSkillCreateInputSchema.safeParse({ ...base, ...patch }).success).toBe(false);
    }
    expect(
      adminSkillCreateVersionInputSchema.safeParse({
        ...concurrency,
        checksum: 'b'.repeat(64),
        content: '# Internal search',
        manifest: {
          ...manifest,
          localizedDescriptions: { 'zh-CN': 'Bearer sk-fake-not-real-localized' },
        },
        skillId: 'skill-1',
        version: '1.0.0',
      }).success,
    ).toBe(false);
  });

  it('strictly models bounded permissions and the permissions_invalid validation code', () => {
    expect(
      adminSkillCreateVersionInputSchema.safeParse({
        ...concurrency,
        checksum: 'b'.repeat(64),
        content: '# Internal search',
        manifest: { ...manifest, permissions: { network: { enabled: true } } },
        skillId: 'skill-1',
        version: '1.0.0',
      }).success,
    ).toBe(false);
    expect(
      skillValidationIssueSchema.safeParse({
        code: 'permissions_invalid',
        message: 'Network permission is not consistent with allowed hosts',
        path: ['manifest', 'permissions', 'network'],
        severity: 'error',
      }).success,
    ).toBe(true);
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

  it('bounds dependent pagination and requires the full write CAS tuple', () => {
    expect(
      adminSkillGetDependentsInputSchema.parse({ limit: 100, skillId: 'skill-1' }),
    ).toMatchObject({ limit: 100, skillId: 'skill-1' });
    expect(
      adminSkillGetDependentsOutputSchema.safeParse({ items: [], nextCursor: null }).success,
    ).toBe(true);
    expect(
      adminSkillGetDependentsOutputSchema.safeParse({ items: [], nextCursor: null, total: 0 })
        .success,
    ).toBe(false);
    expect(
      adminSkillArchiveInputSchema.safeParse({
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 1,
        id: 'skill-1',
        reason: 'archive reviewed skill',
      }).success,
    ).toBe(true);
    for (const field of ['expectedDraftToken', 'expectedRevision', 'reason']) {
      const input: Record<string, unknown> = {
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 1,
        id: 'skill-1',
        reason: 'archive reviewed skill',
      };
      delete input[field];
      expect(adminSkillArchiveInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it('defines strict procedure-specific mutation outputs', () => {
    const version = {
      checksum: 'c'.repeat(64),
      content: '# Internal search',
      createdAt: new Date(),
      createdBy: 'admin-1',
      id: 'version-1',
      manifest,
      skillId: 'skill-1',
      validation: null,
      version: '1.0.0',
    };
    expect(adminSkillCreateVersionOutputSchema.safeParse(version).success).toBe(true);
    expect(
      adminSkillCreateVersionOutputSchema.safeParse({ ...version, contentRef: '/private/path' })
        .success,
    ).toBe(false);
    expect(
      adminSkillValidateOutputSchema.safeParse({
        issues: [],
        validatedAt: new Date(),
        validatorVersion: 'm08-v1',
      }).success,
    ).toBe(true);
    const publication = {
      auditId: 'audit-1',
      catalogRevision: 'catalog-1',
      revision: 1,
      skillId: 'skill-1',
      status: 'published',
      versionId: 'version-1',
    };
    expect(adminSkillPublicationOutputSchema.safeParse(publication).success).toBe(true);
    expect(
      adminSkillPublicationOutputSchema.safeParse({ ...publication, internalPointer: 'secret' })
        .success,
    ).toBe(false);
  });

  it('keeps public catalog free of server-only identifiers and content references', () => {
    const published = {
      checksum: 'c'.repeat(64),
      description: 'Search approved internal sources',
      displayName: 'Internal search',
      distribution: 'default',
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
        skills: [{ ...published, content: '# private', manifest }],
      }).success,
    ).toBe(false);
    expect(
      serverResolvedSkillSchema.safeParse({
        ...published,
        content: '# Internal search',
        contentRef: 's3://private/object',
        manifest,
        skillId: 'skill-1',
        versionId: 'version-1',
      }).success,
    ).toBe(true);
  });
});
