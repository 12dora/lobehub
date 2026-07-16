import type { z } from 'zod';

import {
  PlatformRevisionConflictError,
  PlatformSkillCatalogModel,
  type PlatformSkillDetailView,
  platformSkillDraftToken,
  type PlatformSkillVersionView,
} from '@/database/models/platform';
import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  adminSkillArchiveInputSchema,
  adminSkillCreateInputSchema,
  adminSkillCreateVersionInputSchema,
  adminSkillGetDependentsInputSchema,
  adminSkillRollbackInputSchema,
  adminSkillUpdateDraftInputSchema,
  adminSkillValidateInputSchema,
  ImmutableSkillVersion,
  SkillValidationResult,
} from '../../contracts/skillCatalog';
import { PlatformAuditService } from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { SkillCatalogInvalidCursorError, SkillCatalogNotFoundError } from './errors';
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

const versionView = (version: PlatformSkillVersionView): ImmutableSkillVersion => ({
  ...version,
  validation: validationView(version.validation),
});

const versionSummary = (version: PlatformSkillVersionView) => ({
  checksum: version.checksum,
  createdAt: version.createdAt,
  createdBy: version.createdBy,
  id: version.id,
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
    action: string;
    actorUserId: string;
    afterDiff?: Record<string, unknown>;
    db?: LobeChatDatabase | Transaction;
    reason: string;
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
    action: string;
    actorUserId: string;
    reason: string;
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
    action: string;
    actorUserId: string;
    reason: string;
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

  private mutation = async <T>(params: {
    action: string;
    actorUserId: string;
    reason: string;
    run: () => Promise<T>;
    summarize: (result: T) => Record<string, unknown>;
    targetId: (result?: T) => string;
  }): Promise<T> => {
    try {
      const result = await params.run();
      await this.appendAudit({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: params.summarize(result),
        reason: params.reason,
        result: 'success',
        targetId: params.targetId(result),
      });
      return result;
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

  private detailOutput = (detail: PlatformSkillDetailView) => ({
    baseRevision: detail.baseRevision,
    draft: detail.draft,
    draftToken: detail.draftToken,
    latestVersion: detail.latestVersion ? versionSummary(detail.latestVersion) : null,
    publishedVersion: detail.publishedVersion ? versionSummary(detail.publishedVersion) : null,
  });

  getDetail = async (id: string) => {
    const detail = await this.model().getDetail(id);
    if (!detail) throw new SkillCatalogNotFoundError();
    return this.detailOutput(detail);
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
    if (!(await new PlatformSkillCatalogRepository(this.db).getSkill(params.skillId))) {
      throw new SkillCatalogNotFoundError();
    }
    const page = await new PlatformSkillCatalogRepository(this.db).listVersionPage({
      cursor: parseVersionCursor(params.cursor),
      limit: params.limit,
      skillId: params.skillId,
    });
    return {
      items: page.items.map((row) =>
        versionSummary({
          ...row,
          contentRef: row.contentRef ?? null,
          validation: row.validationResult ?? null,
        }),
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
    const detail = await this.model().getDetail(input.skillId);
    if (!detail) throw new SkillCatalogNotFoundError();
    const validation = await this.validation.validatePayload(this.db, {
      allowBuiltinOverride: detail.draft.allowBuiltinOverride,
      checksum: values.checksum,
      content: values.content,
      contentRef: values.contentRef,
      manifest: values.manifest,
      resources: values.resources,
      skillKey: detail.draft.skillKey,
      version: values.version,
    });
    const version = await this.atomicMutation({
      action: 'admin.skills.createVersion',
      actorUserId,
      reason,
      run: async (tx) => {
        const result = await this.model(tx).createVersion({
          actorUserId,
          ...values,
          validation: { ...validation, validatedAt: validation.validatedAt.toISOString() },
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
    const result = await this.mutation({
      action: 'admin.skills.validate',
      actorUserId,
      reason: input.reason,
      run: () =>
        this.db.transaction(async (tx) => {
          await this.assertDraft(tx, { ...input, id: input.skillId });
          return this.validation.validateStoredVersion(tx, input.skillId, input.versionId);
        }),
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
}
