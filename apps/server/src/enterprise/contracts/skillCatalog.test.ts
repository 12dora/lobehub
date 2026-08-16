import { describe, expect, it } from 'vitest';

import { ADMIN_MUTATION_REGISTRY } from '../security/policy/adminMutationRegistry';
import {
  adminSkillApplyImmediateInputSchema,
  adminSkillArchiveInputSchema,
  adminSkillCreateInputSchema,
  adminSkillCreateVersionInputSchema,
  adminSkillCreateVersionOutputSchema,
  adminSkillGetDependentsInputSchema,
  adminSkillGetDependentsOutputSchema,
  adminSkillGetVersionOutputSchema,
  adminSkillListInputSchema,
  adminSkillListOutputSchema,
  adminSkillListVersionsOutputSchema,
  adminSkillPublicationOutputSchema,
  adminSkillPublishInputSchema,
  adminSkillPublishNowInputSchema,
  adminSkillRollbackInputSchema,
  adminSkillUpdateDraftInputSchema,
  adminSkillValidateInputSchema,
  adminSkillValidateOutputSchema,
  platformSkillOperationProofSchema,
  publishedSkillCatalogSchema,
  serverResolvedSkillSchema,
  skillIdentityDraftSchema,
  skillResourceContentChecksum,
  skillResourceSchema,
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

const REFERENCE_CONTENT = 'reference';
const REFERENCE_CHECKSUM = skillResourceContentChecksum(REFERENCE_CONTENT);

const resource = {
  checksum: REFERENCE_CHECKSUM,
  content: REFERENCE_CONTENT,
  mediaType: 'text/plain',
  path: 'references/source.txt',
  sizeBytes: 9,
};

describe('Skill catalog contracts', () => {
  it('allows a signed operation snapshot with no selected refs', () => {
    expect(
      platformSkillOperationProofSchema.parse({
        agentId: 'agent-1',
        operationId: 'operation-1',
        proof: 'signed-proof',
        refs: [],
        revision: 'catalog-empty',
      }).refs,
    ).toEqual([]);
  });

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

  it('requires a semantic version and rejects client-supplied checksums', () => {
    const input = {
      ...concurrency,
      content: '# Internal search',
      contentRef: null,
      manifest,
      resources: [],
      skillId: 'skill-1',
      version: '1.2.0',
    };
    expect(adminSkillCreateVersionInputSchema.parse(input)).toEqual(input);
    expect(
      adminSkillCreateVersionInputSchema.safeParse({ ...input, version: 'latest' }).success,
    ).toBe(false);
    expect(
      adminSkillCreateVersionInputSchema.safeParse({ ...input, checksum: 'b'.repeat(64) }).success,
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
      content: '# Internal search',
      manifest,
      skillId: 'skill-1',
      version: '1.2.3-alpha.1',
    };
    expect(adminSkillCreateVersionInputSchema.safeParse(input).success).toBe(true);
    // Build metadata is valid SemVer 2.0 and must be accepted.
    expect(
      adminSkillCreateVersionInputSchema.safeParse({ ...input, version: '1.2.3+build.5' }).success,
    ).toBe(true);
    expect(
      adminSkillCreateVersionInputSchema.safeParse({ ...input, version: '2.4.0+corp.17' }).success,
    ).toBe(true);
    for (const version of ['01.2.3', '1.02.3', '1.2.03', '1.2.3-', '1.2.3-alpha..1', 'v1.2.3']) {
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
      { description: '-----BEGIN PRIVATE KEY----- fake material' },
      { reason: 'Imported credential AKIAABCDEFGHIJKLMNOP' },
      { description: 'GCP key AIzaSyA12345678901234567890123456789012' },
      { reason: '{"type":"service_account","project_id":"example"}' },
    ]) {
      expect(adminSkillCreateInputSchema.safeParse({ ...base, ...patch }).success).toBe(false);
    }
    expect(
      adminSkillCreateVersionInputSchema.safeParse({
        ...concurrency,
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

  it('rejects credential-bearing and signed URLs embedded anywhere in public-safe text', () => {
    const base = { displayName: 'Safe skill', reason: 'create reviewed skill', skillKey: 'safe' };
    for (const patch of [
      { description: 'Read https://user:password@example.test/docs before use' },
      { reason: 'Imported from https://example.test/archive?api_key=plain-secret' },
      { description: 'Database postgres://admin:password@db.internal/catalog' },
      { description: 'Repository git+ssh://deploy:token@git.internal/repository' },
      { reason: 'Cache redis://default:password@redis.internal/0' },
      { reason: 'Artifact s3://bucket/key?X-Amz-Signature=plain-signature' },
      {
        description:
          'Sources https://safe.example.test,postgres://admin:password@db.internal/catalog',
      },
      {
        reason: 'Sources s3://safe-bucket/readme;redis://default:password@redis.internal/0',
      },
      {
        description:
          'Sources https://safe.example.test,s3://safe-bucket/key;git+ssh://deploy:token@git.internal/repo',
      },
      { reason: 'Safe https://safe.example.test|redis://default:password@redis.internal/0' },
      { description: 'Safe (https://safe.example.test)(postgres://admin:password@db/catalog)' },
      {
        reason: 'Safe [docs](https://safe.example.test)[db](postgres://admin:password@db/catalog)',
      },
      { description: '安全 https://safe.example.test，redis://default:password@redis.internal/0' },
      { reason: '安全 https://safe.example.test；s3://bucket/key?X-Amz-Signature=secret' },
      { description: 'URI https://example.test/path(foo)?api_key=plain-secret' },
      { description: 'URI https://example.test/path|segment?api_key=plain-secret' },
      { description: 'URI https://example.test/path[part]?api_key=plain-secret' },
      { description: 'URI https://example.test/path，part?api_key=plain-secret' },
    ]) {
      expect(adminSkillCreateInputSchema.safeParse({ ...base, ...patch }).success).toBe(false);
    }
    expect(
      adminSkillCreateVersionInputSchema.safeParse({
        ...concurrency,
        content: '# Internal search',
        manifest: {
          ...manifest,
          localizedDescriptions: {
            'zh-CN': '参考 https://example.test/file?X-Amz-Signature=plain-signature',
          },
        },
        skillId: 'skill-1',
        version: '1.0.0',
      }).success,
    ).toBe(false);
    expect(
      adminSkillCreateInputSchema.safeParse({
        description:
          'Safe paths https://example.test/a,b;c https://example.test/path(foo) https://example.test/path|segment https://example.test/path[part] https://example.test/path，part',
        displayName: 'Safe skill',
        reason: 'reviewed safe URI paths',
        skillKey: 'safe-paths',
      }).success,
    ).toBe(true);
  });

  it('persists builtin override intent in admin/server projections but hides it publicly', () => {
    expect(
      adminSkillCreateInputSchema.parse({
        displayName: 'Reviewed override',
        reason: 'explicit builtin override review',
        skillKey: 'builtin.search',
      }).allowBuiltinOverride,
    ).toBe(false);
    expect(
      skillIdentityDraftSchema.safeParse({
        allowBuiltinOverride: true,
        currentVersionId: null,
        description: null,
        displayName: 'Reviewed override',
        distribution: 'optional',
        draftSequence: 0,
        enabled: false,
        id: 'skill-1',
        revision: 0,
        skillKey: 'builtin.search',
        source: 'uploaded',
        status: 'draft',
      }).success,
    ).toBe(true);
  });

  it('strictly models bounded permissions and the permissions_invalid validation code', () => {
    expect(
      adminSkillCreateVersionInputSchema.safeParse({
        ...concurrency,
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
      skillValidationIssueSchema.parse({
        code: 'non_inline_content',
        message: 'Opaque content is not executable',
        path: ['contentRef'],
        severity: 'error',
      }),
    ).toMatchObject({ code: 'non_inline_content', severity: 'error' });
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

  it('hard-caps admin identity and version page outputs at one hundred items', () => {
    const identity = {
      allowBuiltinOverride: false,
      currentVersionId: null,
      description: null,
      displayName: 'Skill',
      distribution: 'optional',
      draftSequence: 0,
      enabled: false,
      id: 'skill-1',
      revision: 0,
      skillKey: 'skill',
      source: 'uploaded',
      status: 'draft',
    } as const;
    const summary = {
      checksum: 'c'.repeat(64),
      createdAt: new Date(),
      createdBy: 'admin-1',
      id: 'version-1',
      lastPublishedRevision: null,
      skillId: 'skill-1',
      validation: null,
      version: '1.0.0',
    };
    expect(
      adminSkillListVersionsOutputSchema.safeParse({
        items: Array.from({ length: 100 }, (_, index) => ({ ...summary, id: `version-${index}` })),
        nextCursor: 'cursor',
      }).success,
    ).toBe(true);
    expect(
      adminSkillListVersionsOutputSchema.safeParse({
        items: Array.from({ length: 101 }, (_, index) => ({ ...summary, id: `version-${index}` })),
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      adminSkillListOutputSchema.safeParse({
        items: Array.from({ length: 101 }, (_, index) => ({
          ...identity,
          id: `skill-${index}`,
          skillKey: `skill-${index}`,
        })),
        nextCursor: null,
      }).success,
    ).toBe(false);
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
    for (const field of ['expectedDraftToken', 'expectedRevision']) {
      const input: Record<string, unknown> = {
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 1,
        id: 'skill-1',
        reason: 'archive reviewed skill',
      };
      delete input[field];
      expect(adminSkillArchiveInputSchema.safeParse(input).success).toBe(false);
    }
    // The console no longer prompts for a reason on catalog lifecycle actions: omitting it is
    // accepted (audited without a reason), a supplied one is still bounded and secret-scanned.
    expect(
      adminSkillArchiveInputSchema.safeParse({
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 1,
        id: 'skill-1',
      }).success,
    ).toBe(true);
    expect(
      adminSkillArchiveInputSchema.safeParse({
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 1,
        id: 'skill-1',
        reason: '',
      }).success,
    ).toBe(false);
  });

  it('defines strict procedure-specific mutation outputs', () => {
    const version = {
      checksum: 'c'.repeat(64),
      content: '# Internal search',
      contentRef: 'opaque:skill-content-1',
      createdAt: new Date(),
      createdBy: 'admin-1',
      id: 'version-1',
      manifest,
      resources: [resource],
      skillId: 'skill-1',
      validation: null,
      version: '1.0.0',
    };
    expect(adminSkillCreateVersionOutputSchema.safeParse(version).success).toBe(true);
    expect(adminSkillGetVersionOutputSchema.safeParse(version).success).toBe(true);
    const {
      content: _content,
      contentRef: _contentRef,
      manifest: _manifest,
      resources: _resources,
      ...summary
    } = version;
    expect(
      adminSkillListVersionsOutputSchema.safeParse({
        items: [{ ...summary, lastPublishedRevision: 2 }],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      adminSkillListVersionsOutputSchema.safeParse({ items: [version], nextCursor: null }).success,
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
        skills: [{ ...published, content: '# private', manifest, resources: [resource] }],
      }).success,
    ).toBe(false);
    expect(
      publishedSkillCatalogSchema.safeParse({
        revision: 'revision-1',
        skills: [{ ...published, allowBuiltinOverride: true }],
      }).success,
    ).toBe(false);
    expect(
      serverResolvedSkillSchema.safeParse({
        ...published,
        allowBuiltinOverride: true,
        content: '# Internal search',
        contentRef: 'opaque:skill-content-1',
        manifest,
        resources: [resource],
        skillId: 'skill-1',
        versionId: 'version-1',
      }).success,
    ).toBe(true);
  });

  it('binds resource checksum to UTF-8 content bytes (rejects wrong digests)', () => {
    // Known-wrong digest previously accepted by syntax-only validation.
    expect(
      skillResourceSchema.safeParse({
        ...resource,
        checksum: 'd'.repeat(64),
      }).success,
    ).toBe(false);
    const parsed = skillResourceSchema.parse(resource);
    expect(parsed.checksum).toBe(REFERENCE_CHECKSUM);
    expect(parsed.checksum).toBe(skillResourceContentChecksum(parsed.content!));
    // Runtime projections expose checksum as fileHash — they must equal the digest.
    expect(parsed.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('bounds immutable resources and permits only opaque content references', () => {
    const input = {
      ...concurrency,
      content: '# Internal search',
      contentRef: 'opaque:skill-content-1',
      manifest,
      reason: 'create reviewed version',
      resources: [resource],
      skillId: 'skill-1',
      version: '1.2.0',
    };
    expect(adminSkillCreateVersionInputSchema.safeParse(input).success).toBe(true);
    for (const invalid of [
      { ...resource, path: '../secret' },
      { ...resource, path: '/absolute' },
      { ...resource, path: 'nested\\windows.txt' },
      { ...resource, sizeBytes: 8 },
      { ...resource, contentRef: 'opaque:second-source' },
      { ...resource, checksum: 'd'.repeat(64) },
    ]) {
      expect(
        adminSkillCreateVersionInputSchema.safeParse({ ...input, resources: [invalid] }).success,
      ).toBe(false);
    }
    expect(
      adminSkillCreateVersionInputSchema.safeParse({
        ...input,
        contentRef: 's3://bucket/private',
      }).success,
    ).toBe(false);
    expect(
      adminSkillCreateVersionInputSchema.safeParse({
        ...input,
        resources: Array.from({ length: 101 }, (_, index) => ({
          ...resource,
          path: `references/${index}.txt`,
        })),
      }).success,
    ).toBe(false);
  });
});

/**
 * The mutation registry states, per procedure, whether an audit reason is mandatory. That claim is
 * only honest while it matches what the input contract actually accepts, so assert both directions
 * on a payload that is complete except for the reason.
 */
describe('Skill catalog reason contracts match the mutation registry', () => {
  const cas = { expectedDraftToken: 'a'.repeat(64), expectedRevision: 0 };

  it.each([
    ['admin.skills.create', adminSkillCreateInputSchema, { displayName: 'X', skillKey: 'x.skill' }],
    [
      'admin.skills.applyImmediate',
      adminSkillApplyImmediateInputSchema,
      { displayName: 'X', mode: 'create', skillKey: 'x.skill' },
    ],
    ['admin.skills.updateDraft', adminSkillUpdateDraftInputSchema, { ...cas, id: 'skill-1' }],
    [
      'admin.skills.createVersion',
      adminSkillCreateVersionInputSchema,
      {
        ...cas,
        content: '# body',
        manifest,
        resources: [resource],
        skillId: 'skill-1',
        version: '1.0.0',
      },
    ],
    [
      'admin.skills.validate',
      adminSkillValidateInputSchema,
      { ...cas, skillId: 'skill-1', versionId: 'version-1' },
    ],
    [
      'admin.skills.publish',
      adminSkillPublishInputSchema,
      { ...cas, id: 'skill-1', versionId: 'version-1' },
    ],
    [
      'admin.skills.rollback',
      adminSkillRollbackInputSchema,
      { ...cas, id: 'skill-1', targetVersionId: 'version-1' },
    ],
    ['admin.skills.archive', adminSkillArchiveInputSchema, { ...cas, id: 'skill-1' }],
    ['admin.skills.publishNow', adminSkillPublishNowInputSchema, { id: 'skill-1' }],
  ])(
    '%s accepts an omitted reason exactly when the registry says it is optional',
    (procedure, schema, payloadWithoutReason) => {
      const control =
        ADMIN_MUTATION_REGISTRY[procedure as keyof typeof ADMIN_MUTATION_REGISTRY].controls.reason;
      // 'conditional' is the optional-reason declaration; 'enforced' means the contract must reject.
      expect(['conditional', 'enforced']).toContain(control.status);
      expect(schema.safeParse(payloadWithoutReason).success).toBe(control.status === 'conditional');
      // A supplied reason is always accepted and always bounded (whitespace-only is never a reason).
      expect(schema.safeParse({ ...payloadWithoutReason, reason: 'operator note' }).success).toBe(
        true,
      );
      expect(schema.safeParse({ ...payloadWithoutReason, reason: '   ' }).success).toBe(false);
    },
  );
});
