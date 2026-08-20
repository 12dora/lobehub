import { randomUUID } from 'node:crypto';

import { TRACING_SCENARIOS } from '@lobechat/const';
import type { TracingOptions } from '@lobechat/llm-generation-tracing';
import type { ModelExtendParams } from '@lobechat/model-runtime';
import { pickGenerateObjectEffortParams } from '@lobechat/model-runtime';
import {
  chainGenerateSkillMeta,
  chainSummaryTitle,
  GENERATE_SKILL_META_PROMPT_VERSION,
  GENERATE_SKILL_META_SCHEMA,
  GENERATE_SKILL_META_SCHEMA_NAME,
} from '@lobechat/prompts';
import type {
  SystemAgentItem,
  UserSystemAgentConfig,
  UserSystemAgentConfigKey,
} from '@lobechat/types';
import { RequestTrigger } from '@lobechat/types';
import debug from 'debug';

import { isEnterpriseFlagEnabled } from '@/const/platform/featureFlags';
import { UserModel } from '@/database/models/user';
import { AiInfraRepos } from '@/database/repositories/aiInfra';
import type { LobeChatDatabase } from '@/database/type';
import { getEffectiveSystemAgentConfig } from '@/server/enterprise/services/settings/runtimeSettingsAdapter';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import type { RuntimeStateForEffort } from './effort';
import { resolveServiceModelEffortParams } from './effort';
import { resolveSystemAgentModelConfig } from './modelConfig';

const log = debug('lobe-server:system-agent-service');

const TOPIC_TITLE_SCHEMA = {
  name: 'topic_title',
  schema: {
    additionalProperties: false,
    properties: {
      title: { description: 'A concise topic title', type: 'string' },
    },
    required: ['title'],
    type: 'object' as const,
  },
  strict: true,
};

/**
 * Server-side service for SystemAgent automated tasks.
 *
 * Encapsulates the common pattern: read user's systemAgent config → build chain prompt
 * → call LLM via generateObject → return structured result.
 *
 * Each public method corresponds to a `UserSystemAgentConfigKey` task type
 * (topic, translation, agentMeta, etc.).
 */
export class SystemAgentService {
  private readonly db: LobeChatDatabase;
  private readonly userId: string;
  private readonly workspaceId?: string;
  private runtimeStatePromise?: Promise<RuntimeStateForEffort | undefined>;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.db = db;
    this.userId = userId;
    this.workspaceId = workspaceId;
  }

  /**
   * Generate a concise topic title from user prompt + assistant reply.
   *
   * @returns The generated title string, or null on failure
   */
  async generateTopicTitle(params: {
    lastAssistantContent: string;
    userPrompt: string;
  }): Promise<string | null> {
    const { userPrompt, lastAssistantContent } = params;

    try {
      const { model, provider, ...effortParams } = await this.getTaskModelConfig('topic');
      const locale = await this.getUserLocale();

      log('generateTopicTitle: locale=%s, model=%s, provider=%s', locale, model, provider);

      const messages = [
        { content: userPrompt, role: 'user' as const },
        { content: lastAssistantContent, role: 'assistant' as const },
      ];

      const payload = chainSummaryTitle(messages, locale);

      const modelRuntime = await initModelRuntimeFromDB(
        this.db,
        this.userId,
        provider,
        this.workspaceId,
      );
      const result = await modelRuntime.generateObject(
        {
          messages: payload.messages as any[],
          model,
          schema: TOPIC_TITLE_SCHEMA,
          ...pickGenerateObjectEffortParams(effortParams),
        },
        { metadata: { trigger: RequestTrigger.Topic } },
      );

      const title = (result as { title?: string })?.title?.trim();
      if (!title) {
        log('generateTopicTitle: LLM returned empty title');
        return null;
      }

      log('generateTopicTitle: generated title="%s"', title);
      return title;
    } catch (error) {
      console.error('SystemAgentService.generateTopicTitle failed:', error);
      return null;
    }
  }

  /**
   * Generate skill metadata (name / title / description) from a document body,
   * used to prefill the "convert document to skill" form.
   *
   * Emits an `llm_generation_tracing` row under a pre-allocated `tracingId` and
   * returns it so the client can later record implicit feedback (whether the
   * user edited the generated values before saving).
   *
   * @returns The generated metadata + tracingId, or null on failure
   */
  async generateSkillMeta(params: {
    agentId?: string;
    content: string;
  }): Promise<{ description: string; name: string; title: string; tracingId: string } | null> {
    const { agentId, content } = params;
    if (!content.trim()) return null;

    try {
      const { model, provider, ...effortParams } = await this.getTaskModelConfig('agentMeta');
      const locale = await this.getUserLocale();

      log('generateSkillMeta: locale=%s, model=%s, provider=%s', locale, model, provider);

      const payload = chainGenerateSkillMeta({ content, responseLanguage: locale });
      const tracingId = randomUUID();

      const modelRuntime = await initModelRuntimeFromDB(
        this.db,
        this.userId,
        provider,
        this.workspaceId,
      );
      const result = await modelRuntime.generateObject(
        {
          messages: payload.messages as any[],
          model,
          schema: GENERATE_SKILL_META_SCHEMA,
          ...pickGenerateObjectEffortParams(effortParams),
        },
        {
          metadata: { trigger: RequestTrigger.Api },
          tracing: {
            agentId,
            promptVersion: GENERATE_SKILL_META_PROMPT_VERSION,
            scenario: TRACING_SCENARIOS.DocumentToSkillMeta,
            schemaName: GENERATE_SKILL_META_SCHEMA_NAME,
            tracingId,
          } satisfies TracingOptions,
        },
      );

      const meta = result as { description?: string; name?: string; title?: string };
      const name = meta?.name?.trim();
      const title = meta?.title?.trim();
      const description = meta?.description?.trim();

      if (!name || !title || !description) {
        log('generateSkillMeta: LLM returned incomplete meta');
        return null;
      }

      log('generateSkillMeta: generated name="%s", title="%s"', name, title);
      return { description, name, title, tracingId };
    } catch (error) {
      console.error('SystemAgentService.generateSkillMeta failed:', error);
      return null;
    }
  }

  // ============== Private Helpers ============== //

  /**
   * Effective systemAgent item for a task key (policy-aware when the settings
   * policy module is on; raw user settings when it is off).
   */
  async getEffectiveTaskAgentItem(
    taskKey: UserSystemAgentConfigKey,
  ): Promise<Partial<SystemAgentItem> | undefined> {
    try {
      const systemAgent = (await getEffectiveSystemAgentConfig({
        db: this.db,
        userId: this.userId,
      })) as Partial<UserSystemAgentConfig> | undefined;

      return systemAgent?.[taskKey];
    } catch (error) {
      // Policy ON: a resolver/DB failure must not fail-open to unrestricted
      // defaults (that would bypass a locked translation/system-agent model).
      if (isEnterpriseFlagEnabled(process.env.ENABLE_PLATFORM_SETTINGS_POLICY)) {
        throw error;
      }

      log('failed to load systemAgent config with policy off, using raw settings: %O', error);

      try {
        const settings = await new UserModel(this.db, this.userId).getUserSettings();
        return (settings?.systemAgent as Partial<UserSystemAgentConfig> | undefined)?.[taskKey];
      } catch (rawError) {
        log('raw systemAgent settings fallback also failed: %O', rawError);
        return undefined;
      }
    }
  }

  /**
   * Get the model/provider config for a specific systemAgent task type,
   * plus projected effort wire params for the selected model.
   * Falls back to DEFAULT_SYSTEM_AGENT_CONFIG when user has no custom settings.
   */
  async getTaskModelConfig(
    taskKey: UserSystemAgentConfigKey,
  ): Promise<{ model: string; provider: string } & ModelExtendParams> {
    const taskConfig = await this.getEffectiveTaskAgentItem(taskKey);
    const { model, provider } = await resolveSystemAgentModelConfig({ taskConfig, taskKey });
    const runtimeState = await this.getRuntimeStateForEffort();
    const effortParams = await resolveServiceModelEffortParams({
      model,
      provider,
      reasoningEffort: taskConfig?.reasoningEffort,
      runtimeState,
    });

    return { model, provider, ...effortParams };
  }

  private async getRuntimeStateForEffort(): Promise<RuntimeStateForEffort | undefined> {
    if (!this.runtimeStatePromise) {
      this.runtimeStatePromise = (async () => {
        try {
          const aiInfraRepos = new AiInfraRepos(this.db, this.userId, {}, this.workspaceId);
          return await aiInfraRepos.getAiProviderRuntimeState(KeyVaultsGateKeeper.getUserKeyVaults);
        } catch (error) {
          log('failed to load AI provider runtime state for effort lookup: %O', error);
          return undefined;
        }
      })();
    }

    return this.runtimeStatePromise;
  }

  /**
   * Get the user's preferred response language (locale).
   */
  async getUserLocale(): Promise<string> {
    const userInfo = await UserModel.getInfoForAIGeneration(this.db, this.userId);
    return userInfo.responseLanguage || 'en-US';
  }
}
