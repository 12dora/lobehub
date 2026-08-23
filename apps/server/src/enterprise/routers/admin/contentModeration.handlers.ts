import type { z } from 'zod';

import { PlatformContentModerationSettingsModel } from '@/database/models/platform/contentModerationSettings';
import type { LobeChatDatabase } from '@/database/type';
import type { AuthMethod } from '@/libs/trpc/lambda/context';
import type {
  ContentModerationConfig,
  contentModerationSettingsUpdateInputSchema,
  contentModerationTestClassifierInputSchema,
} from '@/types/platform/contentModeration';

import {
  CONTENT_MODERATION_AUDIT_ACTIONS,
  CONTENT_MODERATION_AUDIT_TARGET_TYPES,
} from '../../services/contentModeration/constants';
import { obtainPlatformSecretService } from '../../services/contentModeration/secrets';
import { PlatformAuditService } from '../../services/platformAudit';
import { mapModerationError } from './contentModeration.errors';
import type { getSettingsOutputSchema } from './contentModeration.schemas';
import {
  assertCombinedApiKeyBound,
  assertKeywordRegexesSafe,
  assertRetainedKeysBoundToPersistedEndpoint,
  invalidateModerationSettingsCache,
  loadPublishedModelCatalog,
  loadSystemRoles,
  maskStoredApiKeys,
  resolveDryRunConfig,
  resolvePlaintextApiKeys,
  runClassifierDryRun,
  storedRefsOf,
  summarizeSettingsDiff,
  toPersistedConfig,
  toSettingsView,
  validateCatalogBoundModels,
} from './contentModerationSupport';

export type ModerationHandlerCtx = {
  authenticatedAt?: Date | null;
  // `| null` because that is what the request context really carries: an API-key request has no
  // auth method, and a resolver whose ctx cannot represent that is not a resolver tRPC accepts.
  authMethod?: AuthMethod | null;
  serverDB: LobeChatDatabase;
  userId?: string | null;
};

export const settingsViewFor = async (
  db: LobeChatDatabase,
  row: {
    config: ContentModerationConfig;
    revision: number;
    updatedAt: Date;
    updatedBy: string | null;
  },
) => {
  const apiKeys = await maskStoredApiKeys({
    refs: storedRefsOf(row.config),
    secretService: obtainPlatformSecretService(),
  });
  return toSettingsView({
    apiKeys,
    config: row.config,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  });
};

export const getSettingsPayload = async (db: LobeChatDatabase) => {
  const model = new PlatformContentModerationSettingsModel(db);
  const row = await model.ensureDefault();
  const [settings, catalog, roles] = await Promise.all([
    settingsViewFor(db, row),
    loadPublishedModelCatalog(db),
    loadSystemRoles(db),
  ]);
  return { catalog, roles, settings };
};

export const testClassifier = async ({
  ctx,
  input,
}: {
  ctx: ModerationHandlerCtx;
  input: z.infer<typeof contentModerationTestClassifierInputSchema>;
}) => {
  try {
    const settings = await new PlatformContentModerationSettingsModel(ctx.serverDB).ensureDefault();
    const config = resolveDryRunConfig({
      override: input.config,
      persisted: settings.config,
    });
    const catalog = await loadPublishedModelCatalog(ctx.serverDB);
    validateCatalogBoundModels({ catalog, config });
    await assertKeywordRegexesSafe({
      next: config.keywords,
      previous: settings.config.keywords,
    });
    const storedRefs = storedRefsOf(settings.config);
    const secretService = obtainPlatformSecretService();
    const keep = input.config
      ? (input.config.classifier.moderationsApi?.apiKeys.keep ?? [])
      : (await maskStoredApiKeys({ refs: storedRefs, secretService })).map(
          (key) => key.fingerprint,
        );
    const add = input.config?.classifier.moderationsApi?.apiKeys.add ?? [];
    assertCombinedApiKeyBound(keep, add);
    assertRetainedKeysBoundToPersistedEndpoint({
      keep,
      persistedBaseUrl: settings.config.classifier.moderationsApi?.baseUrl,
      submittedBaseUrl: config.classifier.moderationsApi?.baseUrl,
    });
    const plaintextKeys =
      config.classifier.kind === 'moderations_api'
        ? await resolvePlaintextApiKeys({
            add,
            keep,
            secretService,
            storedRefs,
          })
        : [];

    const result = await runClassifierDryRun({
      config,
      db: ctx.serverDB,
      plaintextKeys,
      text: input.text,
    });

    await new PlatformAuditService(ctx.serverDB).append({
      action: CONTENT_MODERATION_AUDIT_ACTIONS.CLASSIFIER_TEST,
      actorUserId: ctx.userId!,
      afterDiff: {
        kind: config.classifier.kind,
        latencyMs: result.latencyMs,
        policyAction: result.policyAction,
      },
      result: 'success',
      targetId: 'default',
      targetType: CONTENT_MODERATION_AUDIT_TARGET_TYPES.SETTINGS,
    });

    return result;
  } catch (error) {
    return mapModerationError(error);
  }
};

export const updateSettings = async ({
  ctx,
  input,
}: {
  ctx: ModerationHandlerCtx;
  input: z.infer<typeof contentModerationSettingsUpdateInputSchema>;
}): Promise<z.infer<typeof getSettingsOutputSchema>> => {
  try {
    const catalog = await loadPublishedModelCatalog(ctx.serverDB);
    validateCatalogBoundModels({ catalog, config: input.config });

    const secretService = obtainPlatformSecretService();
    const current = await new PlatformContentModerationSettingsModel(ctx.serverDB).get();
    await assertKeywordRegexesSafe({
      next: input.config.keywords,
      previous: current?.config.keywords ?? null,
    });

    return await ctx.serverDB
      .transaction(async (tx) => {
        const settingsModel = new PlatformContentModerationSettingsModel(
          tx as unknown as LobeChatDatabase,
        );
        const latest = await settingsModel.get();
        const persisted = await toPersistedConfig({
          persistedBaseUrl: latest?.config.classifier.moderationsApi?.baseUrl,
          secretService,
          storedRefs: latest ? storedRefsOf(latest.config) : [],
          update: input.config,
        });
        validateCatalogBoundModels({ catalog, config: persisted });

        const next = await settingsModel.update({
          config: persisted,
          expectedRevision: input.expectedRevision,
          updatedBy: ctx.userId!,
        });

        const diff = summarizeSettingsDiff({
          next: persisted,
          previous: latest?.config ?? null,
        });

        await new PlatformAuditService(tx).append({
          action: CONTENT_MODERATION_AUDIT_ACTIONS.SETTINGS_UPDATE,
          actorUserId: ctx.userId!,
          afterDiff: {
            apiKeyCount: diff.apiKeyCount,
            changedSections: diff.changedSections,
            keywordCount: diff.keywordCount,
            revision: next.revision,
          },
          configRevision: next.revision,
          result: 'success',
          targetId: 'default',
          targetType: CONTENT_MODERATION_AUDIT_TARGET_TYPES.SETTINGS,
        });

        const [settings, roles] = await Promise.all([
          settingsViewFor(tx as unknown as LobeChatDatabase, next),
          loadSystemRoles(tx as unknown as LobeChatDatabase),
        ]);

        return { catalog, roles, settings };
      })
      .then((payload) => {
        invalidateModerationSettingsCache(ctx.serverDB);
        return payload;
      });
  } catch (error) {
    return mapModerationError(error);
  }
};
