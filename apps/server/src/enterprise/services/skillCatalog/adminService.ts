import type { z } from 'zod';

import {
  PlatformRevisionConflictError,
  PlatformSkillCatalogModel,
  type PlatformSkillDetailView,
  platformSkillDraftToken,
  platformSkillVersionChecksum,
  type PlatformSkillVersionView,
} from '@/database/models/platform';
import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
import type { PlatformSkillValidationResult } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  adminSkillApplyImmediateInputSchema,
  adminSkillArchiveInputSchema,
  adminSkillCreateInputSchema,
  adminSkillCreateVersionInputSchema,
  adminSkillGetDependentsInputSchema,
  adminSkillPublishNowInputSchema,
  adminSkillRollbackInputSchema,
  adminSkillUpdateDraftInputSchema,
  adminSkillValidateInputSchema,
  ImmutableSkillVersion,
  SkillValidationResult,
} from '../../contracts/skillCatalog';
import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import {
  SkillCatalogInvalidCursorError,
  SkillCatalogNotFoundError,
  SkillCatalogValidationError,
} from './errors';
import {
  type PublishSkillInput,
  type SkillCatalogPublicationOptions,
  SkillCatalogPublicationService,
} from './publication';
import type { BuiltinSkillDefinition } from './readService';
import { SkillCatalogValidationService } from './validationService';

type CreateInput = z.infer<typeof adminSkillCreateInputSchema>;
type UpdateInput = z.infer<typeof adminSkillUpdateDraftInputSchema>;
type CreateVersionInput = z.infer<typeof adminSkillCreateVersionInputSchema>;
type ValidateInput = z.infer<typeof adminSkillValidateInputSchema>;
type ArchiveInput = z.infer<typeof adminSkillArchiveInputSchema>;
type RollbackInput = z.infer<typeof adminSkillRollbackInputSchema>;
type DependentsInput = z.infer<typeof adminSkillGetDependentsInputSchema>;
type ApplyImmediateInput = z.infer<typeof adminSkillApplyImmediateInputSchema>;
type PublishNowInput = z.infer<typeof adminSkillPublishNowInputSchema>;

export interface SkillCatalogAdminServiceOptions {
  allowBuiltinOverride?: boolean;
  builtinSkillKeys?: ReadonlySet<string>;
  builtinSkills?: BuiltinSkillDefinition[];
  invalidation?: PlatformConfigInvalidationPublisher;
  knownToolKeys?: ReadonlySet<string>;
  lifecycle?: {
    beforeSuccessAudit?: () => Promise<void>;
  };
}

const validationView = (
  validation: PlatformSkillVersionView['validation'],
): SkillValidationResult | null => {
  if (!validation) return null;
  return {
    ...validation,
    validatedAt: new Date(validation.validatedAt),
  };
};

/** Persist validation with ISO string timestamps (DB jsonb shape). */
const toStoredValidation = (validation: SkillValidationResult): PlatformSkillValidationResult => ({
  issues: validation.issues,
  validatedAt: validation.validatedAt.toISOString(),
  validatorVersion: validation.validatorVersion,
});

const versionView = (version: PlatformSkillVersionView): ImmutableSkillVersion => ({
  ...version,
  validation: validationView(version.validation),
});

const versionSummary = (
  version: PlatformSkillVersionView,
  lastPublishedRevision: number | null = null,
) => ({
  checksum: version.checksum,
  createdAt: version.createdAt,
  createdBy: version.createdBy,
  id: version.id,
  lastPublishedRevision,
  skillId: version.skillId,
  validation: validationView(version.validation),
  version: version.version,
});

const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const decodeCursor = <T>(cursor: string | undefined, guard: (value: unknown) => value is T) => {
  if (!cursor) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!guard(value)) throw new SkillCatalogInvalidCursorError();
    return value;
  } catch (error) {
    if (error instanceof SkillCatalogInvalidCursorError) throw error;
    throw new SkillCatalogInvalidCursorError();
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const parseVersionCursor = (cursor?: string) => {
  const decoded = decodeCursor(cursor, (value): value is { createdAt: string; id: string } =>
    Boolean(
      isRecord(value) &&
      typeof value.createdAt === 'string' &&
      !Number.isNaN(new Date(value.createdAt).getTime()) &&
      typeof value.id === 'string' &&
      value.id.length > 0,
    ),
  );
  return decoded ? { createdAt: new Date(decoded.createdAt), id: decoded.id } : undefined;
};

const parseDependentCursor = (cursor?: string) =>
  decodeCursor(
    cursor,
    (
      value,
    ): value is {
      id: string;
      key: string;
      type: 'agent' | 'skill';
      version: string;
    } =>
      Boolean(
        isRecord(value) &&
        typeof value.id === 'string' &&
        typeof value.key === 'string' &&
        (value.type === 'agent' || value.type === 'skill') &&
        typeof value.version === 'string',
      ),
  );

export class SkillCatalogAdminService {
  private readonly modelOptions: ConstructorParameters<typeof PlatformSkillCatalogModel>[1];
  private readonly lifecycle: NonNullable<SkillCatalogAdminServiceOptions['lifecycle']>;
  private readonly publication: SkillCatalogPublicationService;
  private readonly validation: SkillCatalogValidationService;

  constructor(
    private readonly db: LobeChatDatabase,
    options: SkillCatalogAdminServiceOptions = {},
  ) {
    const builtinSkillKeys =
      options.builtinSkillKeys ??
      (options.builtinSkills
        ? new Set(options.builtinSkills.map((skill) => skill.skillKey))
        : undefined);
    const validation = {
      allowBuiltinOverride: options.allowBuiltinOverride,
      builtinSkillKeys,
      builtinSkills: options.builtinSkills,
      knownToolKeys: options.knownToolKeys,
    };
    this.modelOptions = {
      allowBuiltinOverride: options.allowBuiltinOverride,
      builtinSkillKeys,
    };
    this.lifecycle = options.lifecycle ?? {};
    this.validation = new SkillCatalogValidationService(validation);
    const publicationOptions: SkillCatalogPublicationOptions = {
      invalidation: options.invalidation,
      validation,
    };
    this.publication = new SkillCatalogPublicationService(db, publicationOptions);
  }

  private model = (db: LobeChatDatabase | Transaction = this.db) =>
    new PlatformSkillCatalogModel(db, this.modelOptions);

  private appendAudit = async (params: {
    action: AuditAction;
    actorUserId: string;
    afterDiff?: Record<string, unknown>;
    db?: LobeChatDatabase | Transaction;
    reason?: string | null;
    result: 'failure' | 'success';
    targetId: string;
  }) => {
    await new PlatformAuditService(params.db ?? this.db).append({
      action: params.action,
      actorUserId: params.actorUserId,
      afterDiff: params.afterDiff,
      reason: params.reason,
      result: params.result,
      targetId: params.targetId,
      targetType: 'skill',
    });
  };

  private appendFailureAudit = async (params: {
    action: AuditAction;
    actorUserId: string;
    reason?: string | null;
    targetId: string;
  }) => {
    try {
      await this.appendAudit({
        ...params,
        afterDiff: { error: 'skill_catalog_mutation_failed' },
        result: 'failure',
      });
    } catch (auditError) {
      console.error('[admin.skills] failure audit append failed', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
  };

  private atomicMutation = async <T>(params: {
    action: AuditAction;
    actorUserId: string;
    reason?: string | null;
    run: (tx: Transaction) => Promise<T>;
    summarize: (result: T) => Record<string, unknown>;
    targetId: (result?: T) => string;
  }): Promise<T> => {
    try {
      return await this.db.transaction(async (tx) => {
        const result = await params.run(tx);
        await this.lifecycle.beforeSuccessAudit?.();
        await this.appendAudit({
          action: params.action,
          actorUserId: params.actorUserId,
          afterDiff: params.summarize(result),
          db: tx,
          reason: params.reason,
          result: 'success',
          targetId: params.targetId(result),
        });
        return result;
      });
    } catch (error) {
      await this.appendFailureAudit({
        action: params.action,
        actorUserId: params.actorUserId,
        reason: params.reason,
        targetId: params.targetId(),
      });
      throw error;
    }
  };

  private assertDraft = async (
    tx: Transaction,
    input: {
      expectedDraftToken: string;
      expectedRevision: number;
      id: string;
    },
  ) => {
    const repository = new PlatformSkillCatalogRepository(tx);
    const locked = await repository.lockSkill(input.id);
    if (!locked) throw new SkillCatalogNotFoundError();
    const detail = await this.model(tx).getDetail(input.id);
    if (!detail) throw new SkillCatalogNotFoundError();
    // Archived is terminal for draft mutations; recovery is rollback only.
    if (detail.draft.status === 'archived') throw new SkillCatalogNotFoundError();
    if (
      detail.baseRevision !== input.expectedRevision ||
      platformSkillDraftToken(detail.draft) !== input.expectedDraftToken
    ) {
      throw new PlatformRevisionConflictError('Skill draft changed', {
        currentRevision: detail.baseRevision,
        expectedRevision: input.expectedRevision,
        resourceId: input.id,
        resourceType: 'skill',
      });
    }
    return detail;
  };

  private detailOutput = (
    detail: PlatformSkillDetailView,
    publishedRevisions: ReadonlyMap<string, number>,
  ) => ({
    baseRevision: detail.baseRevision,
    draft: detail.draft,
    draftToken: detail.draftToken,
    latestVersion: detail.latestVersion
      ? versionSummary(
          detail.latestVersion,
          publishedRevisions.get(detail.latestVersion.id) ?? null,
        )
      : null,
    publishedVersion: detail.publishedVersion
      ? versionSummary(
          detail.publishedVersion,
          publishedRevisions.get(detail.publishedVersion.id) ?? null,
        )
      : null,
  });

  getDetail = async (id: string) => {
    const detail = await this.model().getDetail(id);
    if (!detail) throw new SkillCatalogNotFoundError();
    const versionIds = [detail.latestVersion?.id, detail.publishedVersion?.id].filter(
      (versionId): versionId is string => Boolean(versionId),
    );
    const publishedRevisions = await new PlatformSkillCatalogRepository(
      this.db,
    ).getLastPublishedRevisions(id, versionIds);
    return this.detailOutput(detail, publishedRevisions);
  };

  getVersion = async (skillId: string, versionId: string) => {
    const version = await new PlatformSkillCatalogRepository(this.db).getVersion(
      skillId,
      versionId,
    );
    if (!version) throw new SkillCatalogNotFoundError();
    return versionView({
      ...version,
      contentRef: version.contentRef ?? null,
      validation: version.validationResult ?? null,
    });
  };

  list = async (params: Parameters<PlatformSkillCatalogModel['listSkills']>[0]) =>
    this.model().listSkills(params);

  listVersions = async (params: { cursor?: string; limit?: number; skillId: string }) => {
    const repository = new PlatformSkillCatalogRepository(this.db);
    if (!(await repository.getSkill(params.skillId))) {
      throw new SkillCatalogNotFoundError();
    }
    const page = await repository.listVersionPage({
      cursor: parseVersionCursor(params.cursor),
      limit: params.limit,
      skillId: params.skillId,
    });
    const publishedRevisions = await repository.getLastPublishedRevisions(
      params.skillId,
      page.items.map((item) => item.id),
    );
    return {
      items: page.items.map((row) =>
        versionSummary(
          {
            ...row,
            contentRef: row.contentRef ?? null,
            validation: row.validationResult ?? null,
          },
          publishedRevisions.get(row.id) ?? null,
        ),
      ),
      nextCursor: page.nextCursor
        ? encodeCursor({
            createdAt: page.nextCursor.createdAt.toISOString(),
            id: page.nextCursor.id,
          })
        : null,
    };
  };

  getDependents = async (input: DependentsInput) => {
    const repository = new PlatformSkillCatalogRepository(this.db);
    const skill = await repository.getSkill(input.skillId);
    if (!skill) throw new SkillCatalogNotFoundError();
    const version = input.versionId
      ? await repository.getVersion(input.skillId, input.versionId)
      : undefined;
    if (input.versionId && !version) throw new SkillCatalogNotFoundError();
    const page = await repository.getDependentsPage({
      cursor: parseDependentCursor(input.cursor),
      limit: input.limit,
      skillKey: skill.skillKey,
      version: version?.version,
    });
    return {
      items: page.items,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    };
  };

  create = async (actorUserId: string, input: CreateInput) => {
    const { reason, ...values } = input;
    const detail = await this.atomicMutation({
      action: 'admin.skills.create',
      actorUserId,
      reason,
      run: (tx) => this.model(tx).createSkill({ actorUserId, ...values }),
      summarize: (result) => ({ skillId: result.draft.id, skillKey: result.draft.skillKey }),
      targetId: (result) => result?.draft.id ?? values.skillKey,
    });
    return { draft: detail.draft, draftToken: detail.draftToken };
  };

  updateDraft = async (actorUserId: string, input: UpdateInput) => {
    const { reason, ...values } = input;
    const detail = await this.atomicMutation({
      action: 'admin.skills.updateDraft',
      actorUserId,
      reason,
      run: async (tx) => {
        const result = await this.model(tx).updateDraft({ actorUserId, ...values });
        if (!result) throw new SkillCatalogNotFoundError();
        return result;
      },
      summarize: (result) => ({ draftSequence: result.draft.draftSequence }),
      targetId: () => input.id,
    });
    return { draft: detail.draft, draftToken: detail.draftToken };
  };

  createVersion = async (actorUserId: string, input: CreateVersionInput) => {
    const { reason, ...values } = input;
    const checksum = platformSkillVersionChecksum(values);
    const detail = await this.model().getDetail(input.skillId);
    if (!detail) throw new SkillCatalogNotFoundError();
    const validation = await this.validation.validatePayload(this.db, {
      allowBuiltinOverride: detail.draft.allowBuiltinOverride,
      checksum,
      content: values.content,
      contentRef: values.contentRef,
      manifest: values.manifest,
      resources: values.resources,
      skillKey: detail.draft.skillKey,
      version: values.version,
    });
    // Error-level secret material is non-persistable: never write the credential-bearing
    // immutable version (or bump draft sequence) into PostgreSQL.
    const secretErrors = validation.issues.filter(
      (issue) => issue.code === 'secret_material_detected' && issue.severity === 'error',
    );
    if (secretErrors.length > 0) {
      throw new SkillCatalogValidationError(secretErrors);
    }
    const version = await this.atomicMutation({
      action: 'admin.skills.createVersion',
      actorUserId,
      reason,
      run: async (tx) => {
        const result = await this.model(tx).createVersion({
          actorUserId,
          ...values,
          checksum,
          validation: toStoredValidation(validation),
        });
        if (!result) throw new SkillCatalogNotFoundError();
        return result;
      },
      summarize: (result) => ({
        issueCount: validation.issues.length,
        versionId: result.id,
      }),
      targetId: () => input.skillId,
    });
    return versionView(version);
  };

  validate = async (actorUserId: string, input: ValidateInput) => {
    // Persist validation + success audit in one transaction so a crash between
    // the two cannot leave a validated version without an audit trail.
    const result = await this.atomicMutation({
      action: 'admin.skills.validate',
      actorUserId,
      reason: input.reason,
      run: async (tx) => {
        await this.assertDraft(tx, { ...input, id: input.skillId });
        const validation = await this.validation.validateStoredVersion(
          tx,
          input.skillId,
          input.versionId,
        );
        // Persist the freshly timestamped result so getVersion matches validate
        // (admin UI verifies JSON equality and otherwise locks writes as refreshFailed).
        const stored = await this.model(tx).updateVersionValidation({
          skillId: input.skillId,
          validation: toStoredValidation(validation),
          versionId: input.versionId,
        });
        if (!stored) throw new SkillCatalogNotFoundError();
        return validation;
      },
      summarize: (validation) => ({ issueCount: validation.issues.length }),
      targetId: () => input.skillId,
    });
    return result;
  };

  publish = (actorUserId: string, input: PublishSkillInput) =>
    this.publication.publish(actorUserId, input);

  archive = (actorUserId: string, input: ArchiveInput) =>
    this.publication.archive(actorUserId, input);

  rollback = (actorUserId: string, input: RollbackInput) =>
    this.publication.rollback(actorUserId, input);

  /**
   * Resolve the version id to publish: explicit > latestVersion > currentVersionId.
   */
  private resolvePublishVersionId = async (
    skillId: string,
    preferred?: string,
  ): Promise<string | null> => {
    if (preferred) return preferred;
    const detail = await this.getDetail(skillId);
    return detail.latestVersion?.id ?? detail.draft.currentVersionId ?? null;
  };

  /**
   * Attempt publish; soft-fail returns published:false + publishError (never secrets).
   * When softFail is false and baseRevision > 0, rethrows so the UI can surface failures.
   */
  /**
   * Map publish failures to stable machine-readable codes for client i18n.
   * Never return free-form English messages or raw implementation wording.
   */
  private publishErrorCode = (error: unknown): string => {
    if (error instanceof SkillCatalogValidationError) {
      const codes = error.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.code);
      if (codes.length === 0) return 'validation_failed';
      // Prefer a single code when possible; comma-join keeps multi-issue soft-fails diagnosable.
      return [...new Set(codes)].slice(0, 5).join(',').slice(0, 500);
    }
    return 'publish_failed';
  };

  private tryPublishImmediate = async (
    actorUserId: string,
    skillId: string,
    reason: string | null | undefined,
    versionId: string | null,
    options?: { softFail?: boolean },
  ) => {
    const detail = await this.getDetail(skillId);
    if (!versionId) {
      return {
        auditId: null as string | null,
        draft: detail.draft,
        draftToken: detail.draftToken,
        published: false,
        publishError: 'version_required',
        revision: detail.baseRevision,
        versionId: null as string | null,
      };
    }

    try {
      const published = await this.publish(actorUserId, {
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: skillId,
        reason,
        versionId,
      });
      const after = await this.getDetail(skillId);
      return {
        auditId: published.auditId as string | null,
        draft: after.draft,
        draftToken: after.draftToken,
        published: true,
        publishError: null as string | null,
        revision: published.revision,
        versionId,
      };
    } catch (error) {
      const after = await this.getDetail(skillId);
      const reasonText = this.publishErrorCode(error);
      if (options?.softFail || after.baseRevision === 0) {
        return {
          auditId: null as string | null,
          draft: after.draft,
          draftToken: after.draftToken,
          published: false,
          publishError: reasonText,
          revision: after.baseRevision,
          versionId,
        };
      }
      throw error;
    }
  };

  /**
   * Apply a skill draft mutation then publish immediately (admin settings UI parity).
   * Draft/version writes always commit first; publish failures return the partial-success
   * contract `{published:false, publishError, draft}` so the client can refresh CAS state.
   */
  applyImmediate = async (actorUserId: string, input: ApplyImmediateInput) => {
    let skillId: string;
    let versionId: string | null;

    if (input.mode === 'create') {
      const { mode: _mode, version, ...createInput } = input;
      const created = await this.create(actorUserId, createInput);
      skillId = created.draft.id;
      if (version) {
        const detail = await this.getDetail(skillId);
        const createdVersion = await this.createVersion(actorUserId, {
          content: version.content,
          contentRef: version.contentRef ?? null,
          expectedDraftToken: detail.draftToken,
          expectedRevision: detail.baseRevision,
          manifest: version.manifest,
          reason: input.reason,
          resources: version.resources ?? [],
          skillId,
          version: version.version,
        });
        versionId = createdVersion.id;
      } else {
        versionId = await this.resolvePublishVersionId(skillId);
      }
    } else if (input.mode === 'update') {
      const { mode: _mode, versionId: preferredVersionId, ...updateInput } = input;
      await this.updateDraft(actorUserId, updateInput);
      skillId = input.id;
      versionId = await this.resolvePublishVersionId(skillId, preferredVersionId);
    } else {
      // createVersion
      const { mode: _mode, ...versionInput } = input;
      const createdVersion = await this.createVersion(actorUserId, versionInput);
      skillId = input.skillId;
      versionId = createdVersion.id;
    }

    return this.tryPublishImmediate(actorUserId, skillId, input.reason, versionId, {
      softFail: true,
    });
  };

  /**
   * Banner "retry publish": re-publish latest (or specified) version with soft-fail.
   */
  publishNow = async (actorUserId: string, input: PublishNowInput) => {
    const versionId = await this.resolvePublishVersionId(input.id, input.versionId);
    return this.tryPublishImmediate(actorUserId, input.id, input.reason, versionId, {
      softFail: true,
    });
  };
}
