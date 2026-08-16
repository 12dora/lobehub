import { and, eq } from 'drizzle-orm';

import {
  MODERATION_CATEGORIES,
  type ModerationCategory,
  type ModerationDecisionSource,
} from '@/const/platform/contentModeration';
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { users } from '@/database/schemas';
import { platformAiProviders, platformContentModerationRecords } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type { PlatformSecretService } from '@/server/enterprise/security/secret';
import {
  assessRegexSafety,
  type ContentModerationConfig,
  contentModerationConfigSchema,
  type ContentModerationOverview,
  type ContentModerationOverviewWarning,
  type ContentModerationSettingsUpdateConfig,
  type ContentModerationSettingsView,
  type ContentModerationStatsOutput,
  type ContentModerationTestClassifierOutput,
  type KeywordRule,
  type RegexSafetyResult,
} from '@/types/platform/contentModeration';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { AiCatalogReadService } from '../../services/aiCatalog/catalogReadService';
import { compileKeywordMatcher } from '../../services/contentModeration/keywordMatcher';
import { computePolicyAction, emptyCategoryScores } from '../../services/contentModeration/policy';
import { probeRegexPattern } from '../../services/contentModeration/regexWorker';
import {
  decryptModerationApiKey,
  encryptModerationApiKey,
  fingerprintModerationApiKey,
  maskModerationApiKey,
} from '../../services/contentModeration/secrets';
import { invalidateModerationSnapshot } from '../../services/contentModeration/settingsSnapshot';
import { PlatformRbacService } from '../../services/platformRbac';

export const TEST_CLASSIFIER_TIMEOUT_MS = 8000;
export const STATS_MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000;
export const STATS_HOUR_BUCKET_MS = 3 * 24 * 60 * 60 * 1000;
export const RECORDS_DELETE_MAX = 200;
export const MAX_MODERATION_API_KEYS = 20;
export const MAX_REGEX_PROBES_PER_SAVE = 100;
export const REGEX_PROBE_AGGREGATE_DEADLINE_MS = 5000;

export const CLASSIFIER_ERROR_CODES = [
  'timeout',
  'unauthorized',
  'rate_limited',
  'upstream_error',
  'invalid_response',
  'not_configured',
] as const;
export type ClassifierErrorCode = (typeof CLASSIFIER_ERROR_CODES)[number];

/** Log only a finite code and error class — never exception text or secrets. */
export const logModerationFailure = (scope: string, error: unknown, code: string): void => {
  console.error(`[admin.contentModeration] ${scope}`, {
    code,
    errorClass: error instanceof Error ? error.name : 'UnknownError',
  });
};

const CONFIG_SECTIONS = [
  'autoBan',
  'categories',
  'classifier',
  'decisionCache',
  'downgrade',
  'keywords',
  'messages',
  'mode',
  'notify',
  'records',
  'requestKinds',
  'scope',
] as const;

export type ContentModerationConfigSection = (typeof CONFIG_SECTIONS)[number];

export interface PublishedModerationCatalogModel {
  displayName: string;
  id: string;
}

export interface PublishedModerationCatalogProvider {
  models: PublishedModerationCatalogModel[];
  provider: string;
  providerName: string;
}

export interface ModerationSystemRole {
  displayName?: string;
  name: string;
}

export interface SettingsDiffSummary {
  apiKeyCount: number;
  changedSections: ContentModerationConfigSection[];
  keywordCount: number;
}

export interface MaskedModerationApiKey {
  fingerprint: string;
  masked: string;
}

export interface RecordUserDisplay {
  avatar: string | null;
  email: string | null;
  fullName: string | null;
  username: string | null;
}

const publishedModelKey = (provider: string, model: string): string => `${provider}/${model}`;

export const loadPublishedModelCatalog = async (
  db: LobeChatDatabase,
): Promise<PublishedModerationCatalogProvider[]> => {
  const catalog = await new AiCatalogReadService(db).getPublished();
  return catalog.providers.map((provider) => ({
    models: provider.models.map((model) => ({
      displayName: model.displayName ?? model.modelKey,
      id: model.modelKey,
    })),
    provider: provider.providerKey,
    providerName: provider.displayName,
  }));
};

export const publishedModelKeySet = (
  catalog: readonly PublishedModerationCatalogProvider[],
): Set<string> => {
  const keys = new Set<string>();
  for (const provider of catalog) {
    for (const model of provider.models) {
      keys.add(publishedModelKey(provider.provider, model.id));
    }
  }
  return keys;
};

export const assertPublishedCatalogModel = (params: {
  catalog: readonly PublishedModerationCatalogProvider[];
  field: string;
  model: string;
  provider: string;
}): void => {
  const keys = publishedModelKeySet(params.catalog);
  if (keys.has(publishedModelKey(params.provider, params.model))) return;
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: {
      field: params.field,
      model: params.model,
      provider: params.provider,
      reason: 'model_not_published',
    },
  });
};

export const loadSystemRoles = async (db: LobeChatDatabase): Promise<ModerationSystemRole[]> => {
  const roles = await new PlatformRbacService(db).listSystemRoles();
  return roles.map((role) => ({
    displayName: role.name,
    name: role.name,
  }));
};

/** True when any published managed provider lets the browser fetch the model API. */
export const hasPublishedClientFetchBypass = async (db: LobeChatDatabase): Promise<boolean> => {
  const [row] = await db
    .select({ id: platformAiProviders.id })
    .from(platformAiProviders)
    .where(
      and(
        eq(platformAiProviders.status, 'published'),
        eq(platformAiProviders.enabled, true),
        eq(platformAiProviders.fetchOnClient, true),
      ),
    )
    .limit(1);
  return Boolean(row);
};

export const collectOverviewWarnings = (params: {
  clientFetchBypass: boolean;
  config: ContentModerationConfig;
}): ContentModerationOverviewWarning[] => {
  const warnings: ContentModerationOverviewWarning[] = [];
  if (params.clientFetchBypass) warnings.push('client_fetch_bypass');

  const hasDowngradeAction = MODERATION_CATEGORIES.some(
    (category) => params.config.categories[category].action === 'downgrade',
  );
  if (hasDowngradeAction && params.config.downgrade === null) {
    warnings.push('downgrade_not_configured');
  }

  const enabledKeywordCount = params.config.keywords.filter((rule) => rule.enabled).length;
  if (
    params.config.mode !== 'off' &&
    params.config.classifier.kind === 'none' &&
    enabledKeywordCount === 0
  ) {
    warnings.push('classifier_not_configured');
  }

  return warnings;
};

export const classifierLabel = (config: ContentModerationConfig): string | undefined => {
  if (config.classifier.kind === 'llm_judge' && config.classifier.llmJudge) {
    return `${config.classifier.llmJudge.provider}/${config.classifier.llmJudge.model}`;
  }
  if (config.classifier.kind === 'moderations_api' && config.classifier.moderationsApi) {
    return config.classifier.moderationsApi.model || config.classifier.moderationsApi.baseUrl;
  }
  return undefined;
};

export const invalidateModerationSettingsCache = (db?: LobeChatDatabase): void => {
  invalidateModerationSnapshot(db);
};

export const requireSecretService = (
  secretService: PlatformSecretService | null,
): PlatformSecretService => {
  if (secretService) return secretService;
  return throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
    httpCode: 'PRECONDITION_FAILED',
  });
};

const storedRefsOf = (config: ContentModerationConfig): string[] =>
  config.classifier.moderationsApi?.apiKeyRefs ?? [];

export const maskStoredApiKeys = async (params: {
  refs: readonly string[];
  secretService: PlatformSecretService | null;
}): Promise<MaskedModerationApiKey[]> => {
  if (params.refs.length === 0) return [];
  const secretService = requireSecretService(params.secretService);
  const keys: MaskedModerationApiKey[] = [];
  for (const ref of params.refs) {
    const plaintext = await decryptModerationApiKey(secretService, ref);
    keys.push({
      fingerprint: fingerprintModerationApiKey(plaintext),
      masked: maskModerationApiKey(plaintext),
    });
  }
  return keys;
};

export const toSettingsView = (params: {
  apiKeys: readonly MaskedModerationApiKey[];
  config: ContentModerationConfig;
  revision: number;
  updatedAt: Date;
  updatedBy: string | null;
}): ContentModerationSettingsView => {
  const { classifier, ...rest } = params.config;
  const { moderationsApi, ...classifierRest } = classifier;
  return {
    ...rest,
    classifier: {
      ...classifierRest,
      llmJudge: classifier.llmJudge,
      moderationsApi: moderationsApi
        ? {
            apiKeys: [...params.apiKeys],
            baseUrl: moderationsApi.baseUrl,
            model: moderationsApi.model,
          }
        : undefined,
    },
    revision: params.revision,
    updatedAt: params.updatedAt,
    updatedBy: params.updatedBy,
  };
};

/** Host case + trailing slash only — path remains case-sensitive. */
export const normalizeModerationBaseUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : '';
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${protocol}//${hostname}${port}${pathname}${parsed.search}`;
  } catch {
    return value.trim().replace(/\/+$/, '');
  }
};

export const assertRetainedKeysBoundToPersistedEndpoint = (params: {
  keep: readonly string[];
  persistedBaseUrl?: string;
  submittedBaseUrl?: string;
}): void => {
  if (params.keep.length === 0) return;
  const submitted = params.submittedBaseUrl;
  const persisted = params.persistedBaseUrl;
  if (!submitted) return;
  if (
    persisted &&
    normalizeModerationBaseUrl(persisted) === normalizeModerationBaseUrl(submitted)
  ) {
    return;
  }
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: {
      field: 'classifier.moderationsApi.baseUrl',
      reason: 'endpoint_changed_reenter_keys',
    },
    message: 'Moderations API keys must be re-entered when the endpoint changes.',
  });
};

export const assertCombinedApiKeyBound = (
  keep: readonly string[],
  add: readonly string[],
): void => {
  if (keep.length + add.length <= MAX_MODERATION_API_KEYS) return;
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: {
      field: 'classifier.moderationsApi.apiKeys',
      reason: 'too_many_api_keys',
    },
  });
};

const rejectKeywordRegex = (index: number, reason: 'regex_unsafe' | 'regex_slow'): never =>
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: { field: 'keywords', index, reason },
  });

const rejectTooManyRegexChanges = (): never =>
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: { field: 'keywords', reason: 'too_many_regex_changes' },
  });

/**
 * Static ReDoS check on every enabled regex, then an interruptible worker
 * probe only for patterns that were not previously enabled as regex.
 */
export const assertKeywordRegexesSafe = async (params: {
  next: readonly KeywordRule[];
  now?: () => number;
  previous?: readonly KeywordRule[] | null;
  probe?: (pattern: string, options?: { timeoutMs?: number }) => Promise<RegexSafetyResult>;
}): Promise<void> => {
  const previousEnabled = new Set(
    (params.previous ?? [])
      .filter((rule) => rule.enabled && rule.isRegex)
      .map((rule) => rule.pattern),
  );

  const enabledRegex = params.next
    .map((rule, index) => ({ index, rule }))
    .filter(({ rule }) => rule.enabled && rule.isRegex);

  const changed = enabledRegex.filter(({ rule }) => !previousEnabled.has(rule.pattern));
  if (changed.length > MAX_REGEX_PROBES_PER_SAVE) rejectTooManyRegexChanges();

  for (const { index, rule } of enabledRegex) {
    const staticResult = assessRegexSafety(rule.pattern);
    if (!staticResult.ok) rejectKeywordRegex(index, 'regex_unsafe');
  }

  const probe = params.probe ?? probeRegexPattern;
  const now = params.now ?? Date.now;
  const started = now();
  for (const { index, rule } of changed) {
    if (now() - started > REGEX_PROBE_AGGREGATE_DEADLINE_MS) rejectTooManyRegexChanges();
    const result = await probe(rule.pattern, { timeoutMs: 200 });
    if (result.ok) continue;
    rejectKeywordRegex(index, result.reason === 'invalid' ? 'regex_unsafe' : 'regex_slow');
  }
};

export const parsePersistedConfig = (config: ContentModerationConfig): ContentModerationConfig => {
  const parsed = contentModerationConfigSchema.safeParse(config);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: {
      field: issue?.path.join('.') || 'config',
      reason: 'persisted_config_invalid',
    },
  });
  return config;
};

export const sanitizeClassifierError = (error: unknown, aborted: boolean): ClassifierErrorCode => {
  if (
    aborted ||
    (error instanceof Error && (error.name === 'AbortError' || error.message === 'timeout'))
  ) {
    return 'timeout';
  }
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = /MODERATIONS_API_(\d+)/.exec(message);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (status === 401 || status === 403 || /unauthorized|forbidden/i.test(message)) {
    return 'unauthorized';
  }
  if (
    status === 429 ||
    status === 529 ||
    message.includes('ALL_KEYS_FROZEN') ||
    /rate.?limit/i.test(message)
  ) {
    return 'rate_limited';
  }
  if (
    message.includes('NO_KEYS') ||
    message.includes('RUNTIME_UNAVAILABLE') ||
    message.includes('MODEL_NOT_PUBLISHED') ||
    message.includes('not_configured')
  ) {
    return 'not_configured';
  }
  if (
    /invalid_response|JSON|parse|LLM_JUDGE_RUNTIME_UNSUPPORTED/i.test(message) ||
    status === 400
  ) {
    return 'invalid_response';
  }
  return 'upstream_error';
};

export const resolveApiKeyRefs = async (params: {
  add: readonly string[];
  keep: readonly string[];
  secretService: PlatformSecretService | null;
  storedRefs: readonly string[];
}): Promise<string[]> => {
  if (params.keep.length === 0 && params.add.length === 0) return [];

  const secretService = requireSecretService(params.secretService);
  const keepSet = new Set(params.keep);
  const resolved: string[] = [];
  const found = new Set<string>();

  for (const ref of params.storedRefs) {
    const plaintext = await decryptModerationApiKey(secretService, ref);
    const fingerprint = fingerprintModerationApiKey(plaintext);
    if (!keepSet.has(fingerprint)) continue;
    resolved.push(ref);
    found.add(fingerprint);
  }

  for (const fingerprint of params.keep) {
    if (found.has(fingerprint)) continue;
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      details: {
        field: 'classifier.moderationsApi.apiKeys.keep',
        fingerprint,
        reason: 'api_key_fingerprint_not_found',
      },
    });
  }

  for (const plaintext of params.add) {
    resolved.push(await encryptModerationApiKey(secretService, plaintext));
  }

  return resolved;
};

export const toPersistedConfig = async (params: {
  persistedBaseUrl?: string;
  secretService: PlatformSecretService | null;
  storedRefs: readonly string[];
  update: ContentModerationSettingsUpdateConfig;
}): Promise<ContentModerationConfig> => {
  const { classifier, ...rest } = params.update;
  const { moderationsApi, ...classifierRest } = classifier;

  if (!moderationsApi) {
    return parsePersistedConfig({
      ...rest,
      classifier: {
        ...classifierRest,
        llmJudge: classifier.llmJudge,
      },
    });
  }

  assertCombinedApiKeyBound(moderationsApi.apiKeys.keep, moderationsApi.apiKeys.add);
  assertRetainedKeysBoundToPersistedEndpoint({
    keep: moderationsApi.apiKeys.keep,
    persistedBaseUrl: params.persistedBaseUrl,
    submittedBaseUrl: moderationsApi.baseUrl,
  });

  const apiKeyRefs = await resolveApiKeyRefs({
    add: moderationsApi.apiKeys.add,
    keep: moderationsApi.apiKeys.keep,
    secretService: params.secretService,
    storedRefs: params.storedRefs,
  });

  return parsePersistedConfig({
    ...rest,
    classifier: {
      ...classifierRest,
      llmJudge: classifier.llmJudge,
      moderationsApi: {
        apiKeyRefs,
        baseUrl: moderationsApi.baseUrl,
        model: moderationsApi.model,
      },
    },
  });
};

export const validateCatalogBoundModels = (params: {
  catalog: readonly PublishedModerationCatalogProvider[];
  config: ContentModerationConfig | ContentModerationSettingsUpdateConfig;
}): void => {
  if (params.config.downgrade) {
    assertPublishedCatalogModel({
      catalog: params.catalog,
      field: 'downgrade',
      model: params.config.downgrade.model,
      provider: params.config.downgrade.provider,
    });
  }
  if (params.config.classifier.kind === 'llm_judge' && params.config.classifier.llmJudge) {
    assertPublishedCatalogModel({
      catalog: params.catalog,
      field: 'classifier.llmJudge',
      model: params.config.classifier.llmJudge.model,
      provider: params.config.classifier.llmJudge.provider,
    });
  }
};

const jsonStable = (value: unknown): string => JSON.stringify(value);

export const summarizeSettingsDiff = (params: {
  next: ContentModerationConfig;
  previous: ContentModerationConfig | null;
}): SettingsDiffSummary => {
  const previous = params.previous;
  const changedSections = CONFIG_SECTIONS.filter((section) => {
    if (!previous) return true;
    if (section === 'classifier') {
      const before = previous.classifier;
      const after = params.next.classifier;
      return (
        before.kind !== after.kind ||
        before.onError !== after.onError ||
        before.retryCount !== after.retryCount ||
        before.timeoutMs !== after.timeoutMs ||
        jsonStable(before.llmJudge) !== jsonStable(after.llmJudge) ||
        before.moderationsApi?.baseUrl !== after.moderationsApi?.baseUrl ||
        before.moderationsApi?.model !== after.moderationsApi?.model ||
        (before.moderationsApi?.apiKeyRefs.length ?? 0) !==
          (after.moderationsApi?.apiKeyRefs.length ?? 0)
      );
    }
    return jsonStable(previous[section]) !== jsonStable(params.next[section]);
  });

  return {
    apiKeyCount: params.next.classifier.moderationsApi?.apiKeyRefs.length ?? 0,
    changedSections,
    keywordCount: params.next.keywords.length,
  };
};

export const resolvePlaintextApiKeys = async (params: {
  add: readonly string[];
  keep: readonly string[];
  secretService: PlatformSecretService | null;
  storedRefs: readonly string[];
}): Promise<string[]> => {
  const plaintext: string[] = [];
  if (params.keep.length > 0) {
    const secretService = requireSecretService(params.secretService);
    const keepSet = new Set(params.keep);
    const found = new Set<string>();
    for (const ref of params.storedRefs) {
      const value = await decryptModerationApiKey(secretService, ref);
      const fingerprint = fingerprintModerationApiKey(value);
      if (!keepSet.has(fingerprint)) continue;
      plaintext.push(value);
      found.add(fingerprint);
    }
    for (const fingerprint of params.keep) {
      if (found.has(fingerprint)) continue;
      throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        details: {
          field: 'classifier.moderationsApi.apiKeys.keep',
          fingerprint,
          reason: 'api_key_fingerprint_not_found',
        },
      });
    }
  }
  plaintext.push(...params.add);
  return plaintext;
};

export const buildLlmJudgeDryRunParams = (params: {
  config: ContentModerationSettingsUpdateConfig;
  db: LobeChatDatabase;
  signal: AbortSignal;
}) => ({
  db: params.db,
  extraGuidance: params.config.classifier.llmJudge?.extraGuidance,
  model: params.config.classifier.llmJudge!.model,
  provider: params.config.classifier.llmJudge!.provider,
  retryCount: params.config.classifier.retryCount,
  // Passed as a variable (not an object literal) so extra `signal` is allowed
  // even before the factory type lists it. Credential resolution may still
  // finish in the background if createRuntime ignores the abort.
  signal: params.signal,
  timeoutMs: params.config.classifier.timeoutMs,
});

const classifyWithRemote = async (params: {
  config: ContentModerationSettingsUpdateConfig;
  db: LobeChatDatabase;
  plaintextKeys: readonly string[];
  signal: AbortSignal;
  text: string;
}): Promise<{
  error?: string;
  latencyMs: number;
  scores: Record<ModerationCategory, number>;
  source: Extract<ModerationDecisionSource, 'llm_judge' | 'moderations_api'>;
}> => {
  const kind = params.config.classifier.kind;
  if (kind === 'llm_judge') {
    const { createLlmJudgeClassifier } =
      await import('../../services/contentModeration/classifiers/llmJudge');
    // Abort is forwarded on the factory params (when the type accepts `signal`)
    // and again on classify(). Credential resolution inside createRuntime may
    // still finish in the background if that factory ignores the abort.
    const classifier = createLlmJudgeClassifier(buildLlmJudgeDryRunParams(params));
    const result = await classifier.classify(params.text, params.signal);
    return { latencyMs: result.latencyMs, scores: result.scores, source: 'llm_judge' };
  }

  const { createMemoryKeyHealthPool, createModerationsApiClassifier } =
    await import('../../services/contentModeration/classifiers/moderationsApi');
  const classifier = createModerationsApiClassifier({
    apiKeys: params.plaintextKeys.map((plaintext) => ({
      fingerprint: fingerprintModerationApiKey(plaintext),
      plaintext,
    })),
    baseUrl: params.config.classifier.moderationsApi!.baseUrl,
    keyHealth: createMemoryKeyHealthPool(),
    model: params.config.classifier.moderationsApi!.model,
    retryCount: params.config.classifier.retryCount,
    timeoutMs: params.config.classifier.timeoutMs,
  });
  const result = await classifier.classify(params.text, params.signal);
  return { latencyMs: result.latencyMs, scores: result.scores, source: 'moderations_api' };
};

const runClassifierDryRunBody = async (params: {
  abort: AbortController;
  config: ContentModerationSettingsUpdateConfig;
  db: LobeChatDatabase;
  plaintextKeys: readonly string[];
  started: number;
  text: string;
}): Promise<ContentModerationTestClassifierOutput> => {
  if (params.abort.signal.aborted) {
    throw Object.assign(new Error('timeout'), { name: 'AbortError' });
  }

  const matcher = compileKeywordMatcher(params.config.keywords);
  const matched = await matcher.matchAsync(params.text);
  if (matched) {
    const scores = emptyCategoryScores();
    scores[matched.rule.category] = 1;
    const policy = computePolicyAction({
      categories: params.config.categories,
      matchedRule: matched.rule,
      scores,
    });
    return {
      latencyMs: Date.now() - params.started,
      matchedRule: { id: matched.rule.id, pattern: matched.rule.pattern },
      policyAction: policy.policyAction,
      scores,
      source: 'keyword',
    };
  }

  if (params.config.classifier.kind === 'none') {
    const scores = emptyCategoryScores();
    const policy = computePolicyAction({
      categories: params.config.categories,
      scores,
    });
    return {
      latencyMs: Date.now() - params.started,
      policyAction: policy.policyAction,
      scores,
      source: 'none',
    };
  }

  const remote = await classifyWithRemote({
    config: params.config,
    db: params.db,
    plaintextKeys: params.plaintextKeys,
    signal: params.abort.signal,
    text: params.text,
  });
  const policy = computePolicyAction({
    categories: params.config.categories,
    scores: remote.scores,
  });
  return {
    error: remote.error,
    latencyMs: remote.latencyMs,
    policyAction: policy.policyAction,
    scores: remote.scores,
    source: remote.source,
  };
};

export const runClassifierDryRun = async (params: {
  config: ContentModerationSettingsUpdateConfig;
  db: LobeChatDatabase;
  plaintextKeys: readonly string[];
  text: string;
}): Promise<ContentModerationTestClassifierOutput> => {
  const started = Date.now();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
    }, TEST_CLASSIFIER_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      runClassifierDryRunBody({
        abort,
        config: params.config,
        db: params.db,
        plaintextKeys: params.plaintextKeys,
        started,
        text: params.text,
      }),
      timeout,
    ]);
  } catch (error) {
    const latencyMs = Date.now() - started;
    const timedOut =
      abort.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    const code = sanitizeClassifierError(error, timedOut);
    logModerationFailure('classifier dry-run failed', error, code);
    const scores = emptyCategoryScores();
    const policy = computePolicyAction({
      categories: params.config.categories,
      scores,
    });
    return {
      error: code,
      latencyMs,
      policyAction: params.config.classifier.onError === 'block' ? 'block' : policy.policyAction,
      scores,
      source:
        params.config.classifier.kind === 'none'
          ? 'none'
          : params.config.classifier.kind === 'llm_judge'
            ? 'llm_judge'
            : 'moderations_api',
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (!abort.signal.aborted) abort.abort();
  }
};

export const resolveDryRunConfig = (params: {
  override?: ContentModerationSettingsUpdateConfig;
  persisted: ContentModerationConfig;
}): ContentModerationSettingsUpdateConfig => {
  if (params.override) return params.override;
  const { classifier, ...rest } = params.persisted;
  const { moderationsApi, ...classifierRest } = classifier;
  return {
    ...rest,
    classifier: {
      ...classifierRest,
      llmJudge: classifier.llmJudge,
      moderationsApi: moderationsApi
        ? {
            apiKeys: { add: [], keep: [] },
            baseUrl: moderationsApi.baseUrl,
            model: moderationsApi.model,
          }
        : undefined,
    },
  };
};

/**
 * Lock the record, mark it revealed, and return the stored full prompt.
 * Returns null when the row is gone (concurrent delete) so the caller can
 * reject without writing an audit row.
 */
export const revealRecordPromptAtomic = async (
  db: LobeChatDatabase | Transaction,
  params: { actorUserId: string; id: string },
): Promise<{ prompt: string | null } | null> => {
  const [row] = await db
    .update(platformContentModerationRecords)
    .set({
      revealedAt: new Date(),
      revealedBy: params.actorUserId,
    })
    .where(eq(platformContentModerationRecords.id, params.id))
    .returning({
      promptFull: platformContentModerationRecords.promptFull,
    });
  if (!row) return null;
  return { prompt: row.promptFull ?? null };
};

export const loadRecordUser = async (
  db: LobeChatDatabase | Transaction,
  userId: string | null,
): Promise<RecordUserDisplay | null> => {
  if (!userId) return null;
  const [row] = await db
    .select({
      avatar: users.avatar,
      email: users.email,
      fullName: users.fullName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
};

export const statsBucketForRange = (from: Date, to: Date): 'hour' | 'day' =>
  to.getTime() - from.getTime() <= STATS_HOUR_BUCKET_MS ? 'hour' : 'day';

export const assertStatsRange = (from: Date, to: Date): void => {
  const span = to.getTime() - from.getTime();
  if (span < 0) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { field: 'to', reason: 'range_inverted' },
    });
  }
  if (span > STATS_MAX_RANGE_MS) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { field: 'to', reason: 'range_too_long' },
    });
  }
};

export const assertStatsTimeZone = (timeZone: string): void => {
  const supported = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  if (supported.has(timeZone)) return;
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
    details: { field: 'timezone', reason: 'unknown_timezone' },
  });
};

export const buildOverview = (params: {
  cacheCount: number;
  clientFetchBypass: boolean;
  config: ContentModerationConfig;
  health: ContentModerationOverview['classifier']['health'];
  updatedAt: Date | null;
}): ContentModerationOverview => ({
  autoBan: {
    enabled: params.config.autoBan.enabled,
    threshold: params.config.autoBan.threshold,
    windowDays: params.config.autoBan.windowDays,
  },
  classifier: {
    health: params.health,
    kind: params.config.classifier.kind,
    label: classifierLabel(params.config),
  },
  decisionCacheCount: params.cacheCount,
  downgrade: params.config.downgrade,
  keywordRuleCount: params.config.keywords.filter((rule) => rule.enabled).length,
  mode: params.config.mode,
  updatedAt: params.updatedAt,
  warnings: collectOverviewWarnings({
    clientFetchBypass: params.clientFetchBypass,
    config: params.config,
  }),
});

export const emptyStats = (): ContentModerationStatsOutput => ({
  categories: [],
  kpi: {
    allow: 0,
    avgLatencyMs: null,
    block: 0,
    downgrade: 0,
    error: 0,
    log: 0,
    total: 0,
    wouldBlock: 0,
    wouldDowngrade: 0,
  },
  requestKinds: [],
  series: [],
  sources: [],
  topUsers: [],
});

export { storedRefsOf };
