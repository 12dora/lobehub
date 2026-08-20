import type { EvaluateResult, RubricResult } from '@lobechat/eval-rubric';
import { evaluate } from '@lobechat/eval-rubric';
import type { ModelExtendParams } from '@lobechat/model-runtime';
import { pickGenerateObjectEffortParams } from '@lobechat/model-runtime';
import type { EvalBenchmarkRubric, UserSystemAgentConfig } from '@lobechat/types';
import debug from 'debug';

import { AiInfraRepos } from '@/database/repositories/aiInfra';
import type { LobeChatDatabase } from '@/database/type';
import { getEffectiveSystemAgentConfig } from '@/server/enterprise/services/settings/runtimeSettingsAdapter';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { resolveServiceModelEffortParams } from '../systemAgent/effort';
import { resolveSystemAgentModelConfig } from '../systemAgent/modelConfig';

const log = debug('task-review');

export interface ReviewConfig {
  autoRetry: boolean;
  enabled: boolean;
  judge: ReviewJudge;
  maxIterations: number;
  rubrics: EvalBenchmarkRubric[];
}

export interface ReviewJudge {
  model?: string;
  prompt?: string;
  provider?: string;
}

export interface ReviewResult {
  iteration: number;
  overallScore: number;
  passed: boolean;
  rubricResults: RubricResult[];
  suggestions: string[];
}

export class TaskReviewService {
  private db: LobeChatDatabase;
  private userId: string;
  private workspaceId?: string;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.db = db;
    this.userId = userId;
    this.workspaceId = workspaceId;
  }

  async review(params: {
    content: string;
    iteration?: number;
    judge: ReviewJudge;
    rubrics: EvalBenchmarkRubric[];
    taskName: string;
  }): Promise<ReviewResult> {
    const { content, rubrics, judge, taskName, iteration = 1 } = params;

    // 1. Resolve model/provider + projected effort params
    const { model, provider, ...effortParams } = await this.resolveModelConfig(judge);

    log(
      'Starting review for task %s (iteration %d, model=%s, provider=%s, rubrics=%d)',
      taskName,
      iteration,
      model,
      provider,
      rubrics.length,
    );

    // 2. Initialize ModelRuntime for LLM-based rubrics
    const modelRuntime = await initModelRuntimeFromDB(
      this.db,
      this.userId,
      provider,
      this.workspaceId,
    );

    // 3. Run evaluate() from @lobechat/eval-rubric
    const result: EvaluateResult = await evaluate(
      {
        actual: content,
        rubrics,
        testCase: { input: taskName },
      },
      {
        matchContext: {
          generateObject: async (payload) => {
            return (modelRuntime as any).generateObject(
              {
                messages: payload.messages as any[],
                model: payload.model || model,
                schema: { name: 'judge_score', schema: payload.schema },
                ...pickGenerateObjectEffortParams(effortParams),
              },
              { metadata: { trigger: 'task-review' } },
            );
          },
          judgeModel: model,
        },
        passThreshold: 0.6,
      },
    );

    log('Review complete: %s (score: %.2f, passed: %s)', taskName, result.score, result.passed);

    return {
      iteration,
      overallScore: Math.round(result.score * 100),
      passed: result.passed,
      rubricResults: result.rubricResults,
      suggestions: [],
    };
  }

  private async resolveModelConfig(
    judge: ReviewJudge,
  ): Promise<{ model: string; provider: string } & ModelExtendParams> {
    const systemAgent = (await getEffectiveSystemAgentConfig({
      db: this.db,
      userId: this.userId,
    })) as Partial<UserSystemAgentConfig> | undefined;
    const topicConfig = systemAgent?.topic;

    const { model, provider } =
      judge.model && judge.provider
        ? await resolveSystemAgentModelConfig({
            override: judge,
            taskKey: 'topic',
          })
        : await resolveSystemAgentModelConfig({
            override: judge,
            taskConfig: topicConfig,
            taskKey: 'topic',
          });

    let runtimeState;
    try {
      const aiInfraRepos = new AiInfraRepos(this.db, this.userId, {}, this.workspaceId);
      runtimeState = await aiInfraRepos.getAiProviderRuntimeState(
        KeyVaultsGateKeeper.getUserKeyVaults,
      );
    } catch (error) {
      log('failed to load AI provider runtime state for effort lookup: %O', error);
    }

    const effortParams = await resolveServiceModelEffortParams({
      model,
      provider,
      reasoningEffort: topicConfig?.reasoningEffort,
      runtimeState,
    });

    return { model, provider, ...effortParams };
  }
}
