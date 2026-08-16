// @vitest-environment node
import {
  LobeAnthropicAI,
  LobeAzureOpenAI,
  LobeBedrockAI,
  LobeComfyUI,
  LobeDeepSeekAI,
  LobeGoogleAI,
  LobeGroq,
  LobeMinimaxAI,
  LobeMistralAI,
  LobeMoonshotAI,
  LobeOllamaAI,
  LobeOpenAI,
  LobeOpenRouterAI,
  LobePerplexityAI,
  LobeQwenAI,
  LobeStepfunAI,
  LobeTogetherAI,
  LobeZeroOneAI,
  LobeZhipuAI,
  ModelRuntime,
} from '@lobechat/model-runtime';
import { LobeVertexAI } from '@lobechat/model-runtime/vertexai';
import { type ClientSecretPayload } from '@lobechat/types';
import { ModelProvider } from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlatformSecretService } from '@/server/enterprise/security/secret';
import { AiCatalogExecutionResolver } from '@/server/enterprise/services/aiCatalog';
import type * as AiCatalogEnforcement from '@/server/enterprise/services/aiCatalog/enforcement';
import { wrapModelRuntimeWithModeration } from '@/server/enterprise/services/contentModeration/runtime';
import { createDefaultModerationRuntimeDeps } from '@/server/enterprise/services/contentModeration/runtime/defaults';

import {
  buildPayloadFromKeyVaults,
  hasModelRuntimeEnvironmentFallback,
  initModelRuntimeFromDB,
  initModelRuntimeWithUserPayload,
  initPlatformExactModelRuntime,
  resolveManagedChatApiMode,
} from './index';
import * as platformAiRuntimeBridge from './platformAiRuntimeBridge';

interface InspectableBedrockRuntime {
  client: {
    config: {
      token?: () => Promise<{ token: string }>;
    };
  };
  region: string;
}

// The published 平台托管 policy — not the feature flag — authorizes the platform takeover.
// The catalog runtime bridge imports `./enforcement` directly, so the mock must target it.
const enforcementMocks = vi.hoisted(() => ({ takeover: true }));
vi.mock('@/server/enterprise/services/aiCatalog/enforcement', async (importOriginal) => ({
  ...(await importOriginal<typeof AiCatalogEnforcement>()),
  isPlatformAiTakeoverActive: vi.fn(async () => enforcementMocks.takeover),
}));

// 模拟依赖项
vi.mock('@/envs/llm', () => ({
  getLLMConfig: vi.fn(() => ({
    // 确保为每个provider提供必要的配置信息
    OPENAI_API_KEY: 'test-openai-key',
    GOOGLE_API_KEY: 'test-google-key',

    AZURE_API_KEY: 'test-azure-key',
    AZURE_ENDPOINT: 'https://test-azure.openai.azure.com',

    ZHIPU_API_KEY: 'test.zhipu-key',
    MOONSHOT_API_KEY: 'test-moonshot-key',
    AWS_SECRET_ACCESS_KEY: 'test-aws-secret',
    AWS_ACCESS_KEY_ID: 'test-aws-id',
    AWS_REGION: 'test-aws-region',
    AWS_SESSION_TOKEN: 'test-aws-session-token',
    OLLAMA_PROXY_URL: 'https://test-ollama-url.local',
    PERPLEXITY_API_KEY: 'test-perplexity-key',
    DEEPSEEK_API_KEY: 'test-deepseek-key',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    MINIMAX_API_KEY: 'test-minimax-key',
    MISTRAL_API_KEY: 'test-mistral-key',
    OPENROUTER_API_KEY: 'test-openrouter-key',
    TOGETHERAI_API_KEY: 'test-togetherai-key',
    QINIU_API_KEY: 'test-qiniu-key',
    QWEN_API_KEY: 'test-qwen-key',
    STEPFUN_API_KEY: 'test-stepfun-key',
  })),
}));

/**
 * Test cases for function initModelRuntimeWithUserPayload
 * this method will use ModelRuntime from `@lobechat/model-runtime`
 * and method `getLlmOptionsFromPayload` to initialize runtime
 * with user payload. Test case below will test both the methods
 */
describe('initModelRuntimeWithUserPayload method', () => {
  describe('should initialize with options correctly', () => {
    it('OpenAI provider: with apikey and endpoint', async () => {
      const jwtPayload: ClientSecretPayload = {
        apiKey: 'user-openai-key',
        baseURL: 'user-endpoint',
      };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.OpenAI, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeOpenAI);
      expect(runtime['_runtime'].baseURL).toBe(jwtPayload.baseURL);
    });

    it('Azure AI provider: with apikey, endpoint and apiversion', async () => {
      const jwtPayload: ClientSecretPayload = {
        apiKey: 'user-azure-key',
        baseURL: 'https://user-azure.openai.azure.com',
        azureApiVersion: '2024-06-01',
      };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Azure, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeAzureOpenAI);
      expect(runtime['_runtime'].baseURL).toBe('https://user-azure.openai.azure.com/openai/v1');
    });

    it('Custom provider should use runtimeProvider to init', async () => {
      const jwtPayload: ClientSecretPayload = {
        apiKey: 'user-azure-key',
        azureApiVersion: '2024-06-01',
        baseURL: 'https://user-azure.openai.azure.com',
        runtimeProvider: ModelProvider.Azure,
      };
      const runtime = await initModelRuntimeWithUserPayload('custom-provider', jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeAzureOpenAI);
      expect(runtime['_runtime'].baseURL).toBe('https://user-azure.openai.azure.com/openai/v1');
    });

    it('ZhiPu AI provider: with apikey', async () => {
      const jwtPayload: ClientSecretPayload = { apiKey: 'zhipu.user-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.ZhiPu, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeZhipuAI);
    });

    it('Google provider: with apikey', async () => {
      const jwtPayload: ClientSecretPayload = { apiKey: 'user-google-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Google, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeGoogleAI);
    });

    it('Moonshot AI provider: with apikey', async () => {
      const jwtPayload: ClientSecretPayload = { apiKey: 'user-moonshot-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Moonshot, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeMoonshotAI);
    });

    it('Qwen AI provider: with apikey', async () => {
      const jwtPayload: ClientSecretPayload = { apiKey: 'user-qwen-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Qwen, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeQwenAI);
    });

    it('Vertex AI provider: with service account json', async () => {
      const credentials = {
        client_email: 'vertex@test-project.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n',
        project_id: 'test-project',
        type: 'service_account',
      };
      const payload: ClientSecretPayload = { apiKey: JSON.stringify(credentials) };
      const initSpy = vi
        .spyOn(LobeVertexAI, 'initFromVertexAI')
        .mockImplementation((options: any) => {
          expect(options.project).toBe('test-project');
          expect(options.googleAuthOptions?.credentials?.private_key).toContain('TEST');

          return new LobeGoogleAI({
            apiKey: 'avoid-error',
            client: {} as any,
            isVertexAi: true,
          });
        });

      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.VertexAI, payload);

      expect(initSpy).toHaveBeenCalledTimes(1);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeGoogleAI);

      initSpy.mockRestore();
    });

    it('Bedrock AI provider: with apikey, awsAccessKeyId, awsSecretAccessKey, awsRegion', async () => {
      const jwtPayload: ClientSecretPayload = {
        apiKey: 'user-bedrock-key',
        awsAccessKeyId: 'user-aws-id',
        awsSecretAccessKey: 'user-aws-secret',
        awsRegion: 'user-aws-region',
      };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Bedrock, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeBedrockAI);
    });

    it('Bedrock AI provider: with API key only', async () => {
      const jwtPayload: ClientSecretPayload = {
        apiKey: 'user-bedrock-api-key',
        awsRegion: 'us-east-1',
      };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Bedrock, jwtPayload);

      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeBedrockAI);
    });

    it('Bedrock AI provider: picks one API key with server key selection', async () => {
      const apiKey = 'user-bedrock-api-key-a,user-bedrock-api-key-b';
      const jwtPayload: ClientSecretPayload = {
        apiKey,
        awsRegion: 'us-east-1',
      };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Bedrock, jwtPayload);
      const bedrockRuntime = runtime['_runtime'] as unknown as InspectableBedrockRuntime;
      const token = await bedrockRuntime.client.config.token?.();

      expect(apiKey.split(',')).toContain(token?.token);
    });

    it('Bedrock AI provider: with legacy AWS credentials only', async () => {
      const jwtPayload: ClientSecretPayload = {
        awsAccessKeyId: 'user-aws-id',
        awsSecretAccessKey: 'user-aws-secret',
        awsRegion: 'user-aws-region',
      };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Bedrock, jwtPayload);

      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeBedrockAI);
    });

    it('Bedrock AI provider: falls back to env credentials when only region is provided', async () => {
      const jwtPayload: ClientSecretPayload = {
        awsRegion: 'custom-aws-region',
      };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Bedrock, jwtPayload);

      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeBedrockAI);
      expect((runtime['_runtime'] as unknown as InspectableBedrockRuntime).region).toBe(
        'custom-aws-region',
      );
    });

    it('Ollama provider: with endpoint', async () => {
      const jwtPayload: ClientSecretPayload = { baseURL: 'http://user-ollama-url' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Ollama, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeOllamaAI);
      expect(runtime['_runtime']['baseURL']).toEqual(jwtPayload.baseURL);
    });

    it('Perplexity AI provider: with apikey', async () => {
      const jwtPayload: ClientSecretPayload = { apiKey: 'user-perplexity-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Perplexity, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobePerplexityAI);
    });

    it('Anthropic AI provider: with apikey', async () => {
      const jwtPayload: ClientSecretPayload = { apiKey: 'user-anthropic-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Anthropic, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeAnthropicAI);
    });

    it('Minimax AI provider: with apikey', async () => {
      const jwtPayload: ClientSecretPayload = { apiKey: 'user-minimax-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Minimax, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeMinimaxAI);
    });

    it('Mistral AI provider: with apikey', async () => {
      const jwtPayload: ClientSecretPayload = { apiKey: 'user-mistral-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Mistral, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeMistralAI);
    });

    it('OpenRouter AI provider: with apikey', async () => {
      const jwtPayload: ClientSecretPayload = { apiKey: 'user-openrouter-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.OpenRouter, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeOpenRouterAI);
    });

    it('DeepSeek AI provider: with apikey', async () => {
      const jwtPayload: ClientSecretPayload = { apiKey: 'user-deepseek-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.DeepSeek, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeDeepSeekAI);
    });

    it('Together AI provider: with apikey', async () => {
      const jwtPayload: ClientSecretPayload = { apiKey: 'user-togetherai-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.TogetherAI, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeTogetherAI);
    });

    it('ZeroOne AI provider: with apikey', async () => {
      const jwtPayload = { apiKey: 'user-zeroone-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.ZeroOne, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeZeroOneAI);
    });

    it('Groq AI provider: with apikey', async () => {
      const jwtPayload = { apiKey: 'user-zeroone-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Groq, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeGroq);
    });

    it('Stepfun AI provider: with apikey', async () => {
      const jwtPayload = { apiKey: 'user-stepfun-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Stepfun, jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeStepfunAI);
    });

    it('ComfyUI provider: with multiple auth types', async () => {
      // Test basic auth
      const basicAuthPayload: ClientSecretPayload = {
        authType: 'basic',
        username: 'test-user',
        password: 'test-pass',
        baseURL: 'http://localhost:8188',
      };
      let runtime = await initModelRuntimeWithUserPayload(ModelProvider.ComfyUI, basicAuthPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeComfyUI);
      expect(runtime['_runtime'].baseURL).toBe(basicAuthPayload.baseURL);

      // Test bearer auth
      const bearerAuthPayload: ClientSecretPayload = {
        authType: 'bearer',
        apiKey: 'test-token',
        baseURL: 'http://localhost:8188',
      };
      runtime = await initModelRuntimeWithUserPayload(ModelProvider.ComfyUI, bearerAuthPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeComfyUI);

      // Test custom auth
      const customAuthPayload: ClientSecretPayload = {
        authType: 'custom',
        customHeaders: { 'X-API-Key': 'secret123' },
        baseURL: 'http://localhost:8188',
      };
      runtime = await initModelRuntimeWithUserPayload(ModelProvider.ComfyUI, customAuthPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeComfyUI);

      // Test none auth
      const noAuthPayload: ClientSecretPayload = {
        authType: 'none',
        baseURL: 'http://localhost:8188',
      };
      runtime = await initModelRuntimeWithUserPayload(ModelProvider.ComfyUI, noAuthPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeComfyUI);
    });

    it('Unknown Provider: with apikey and endpoint, should initialize to OpenAi', async () => {
      const jwtPayload: ClientSecretPayload = {
        apiKey: 'user-unknown-key',
        baseURL: 'user-unknown-endpoint',
      };
      const runtime = await initModelRuntimeWithUserPayload('unknown', jwtPayload);
      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeOpenAI);
      expect(runtime['_runtime'].baseURL).toBe(jwtPayload.baseURL);
    });
  });

  describe('should initialize without some options', () => {
    it('OpenAI provider: without apikey', async () => {
      const jwtPayload: ClientSecretPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.OpenAI, jwtPayload);
      expect(runtime['_runtime']).toBeInstanceOf(LobeOpenAI);
    });

    it('Azure AI Provider: without apikey', async () => {
      const jwtPayload: ClientSecretPayload = {
        azureApiVersion: 'test-azure-api-version',
      };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Azure, jwtPayload);

      expect(runtime['_runtime']).toBeInstanceOf(LobeAzureOpenAI);
    });

    it('ZhiPu AI provider: without apikey', async () => {
      const jwtPayload: ClientSecretPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.ZhiPu, jwtPayload);

      // 假设 LobeZhipuAI 是 ZhiPu 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeZhipuAI);
    });

    it('Google provider: without apikey', async () => {
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Google, {});

      // 假设 LobeGoogleAI 是 Google 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeGoogleAI);
    });

    it('Moonshot AI provider: without apikey', async () => {
      const jwtPayload: ClientSecretPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Moonshot, jwtPayload);

      // 假设 LobeMoonshotAI 是 Moonshot 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeMoonshotAI);
    });

    it('Qwen AI provider: without apikey', async () => {
      const jwtPayload: ClientSecretPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Qwen, jwtPayload);

      // 假设 LobeQwenAI 是 Qwen 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeQwenAI);
    });

    it('Qwen AI provider: without endpoint', async () => {
      const jwtPayload: ClientSecretPayload = { apiKey: 'user-qwen-key' };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Qwen, jwtPayload);

      // 假设 LobeQwenAI 是 Qwen 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeQwenAI);
      // endpoint 不存在，应返回 DEFAULT_BASE_URL
      expect(runtime['_runtime'].baseURL).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    });

    it('Bedrock AI provider: without apikey', async () => {
      const jwtPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Bedrock, jwtPayload);

      // 假设 LobeBedrockAI 是 Bedrock 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeBedrockAI);
    });

    it('Ollama provider: without endpoint', async () => {
      const jwtPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Ollama, jwtPayload);

      // 假设 LobeOllamaAI 是 Ollama 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeOllamaAI);
    });

    it('Perplexity AI provider: without apikey', async () => {
      const jwtPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Perplexity, jwtPayload);

      // 假设 LobePerplexityAI 是 Perplexity 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobePerplexityAI);
    });

    it('Anthropic AI provider: without apikey', async () => {
      const jwtPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Anthropic, jwtPayload);

      // 假设 LobeAnthropicAI 是 Anthropic 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeAnthropicAI);
    });

    it('Minimax AI provider: without apikey', async () => {
      const jwtPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Minimax, jwtPayload);

      // 假设 LobeMistralAI 是 Mistral 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeMinimaxAI);
    });

    it('Mistral AI provider: without apikey', async () => {
      const jwtPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Mistral, jwtPayload);

      // 假设 LobeMistralAI 是 Mistral 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeMistralAI);
    });

    it('OpenRouter AI provider: without apikey', async () => {
      const jwtPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.OpenRouter, jwtPayload);

      // 假设 LobeOpenRouterAI 是 OpenRouter 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeOpenRouterAI);
    });

    it('DeepSeek AI provider: without apikey', async () => {
      const jwtPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.DeepSeek, jwtPayload);

      // 假设 LobeDeepSeekAI 是 DeepSeek 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeDeepSeekAI);
    });

    it('Stepfun AI provider: without apikey', async () => {
      const jwtPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Stepfun, jwtPayload);

      // 假设 LobeDeepSeekAI 是 DeepSeek 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeStepfunAI);
    });

    it('Together AI provider: without apikey', async () => {
      const jwtPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.TogetherAI, jwtPayload);

      // 假设 LobeTogetherAI 是 TogetherAI 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeTogetherAI);
    });

    it('OpenAI provider: without apikey with OPENAI_PROXY_URL', async () => {
      process.env.OPENAI_PROXY_URL = 'https://proxy.example.com/v1';

      const jwtPayload: ClientSecretPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.OpenAI, jwtPayload);
      expect(runtime['_runtime']).toBeInstanceOf(LobeOpenAI);
      // 应返回 OPENAI_PROXY_URL
      expect(runtime['_runtime'].baseURL).toBe('https://proxy.example.com/v1');
    });

    it('Qwen AI provider: without apiKey and endpoint with OPENAI_PROXY_URL', async () => {
      process.env.OPENAI_PROXY_URL = 'https://proxy.example.com/v1';

      const jwtPayload: ClientSecretPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.Qwen, jwtPayload);

      // 假设 LobeQwenAI 是 Qwen 提供者的实现类
      expect(runtime['_runtime']).toBeInstanceOf(LobeQwenAI);
      // endpoint 不存在，应返回 DEFAULT_BASE_URL
      expect(runtime['_runtime'].baseURL).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    });

    it('ComfyUI provider: without user payload (using environment variables)', async () => {
      const jwtPayload: ClientSecretPayload = {};
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.ComfyUI, jwtPayload);

      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeComfyUI);
      // Should use environment variable defaults
      expect(runtime['_runtime'].baseURL).toBe('http://127.0.0.1:8000');
    });

    it('ComfyUI provider: partial payload (mixed with env vars)', async () => {
      const jwtPayload: ClientSecretPayload = {
        baseURL: 'http://custom-comfyui:8188',
        // authType, username, password will come from env vars
      };
      const runtime = await initModelRuntimeWithUserPayload(ModelProvider.ComfyUI, jwtPayload);

      expect(runtime).toBeInstanceOf(ModelRuntime);
      expect(runtime['_runtime']).toBeInstanceOf(LobeComfyUI);
      expect(runtime['_runtime'].baseURL).toBe('http://custom-comfyui:8188');
    });

    it('Unknown Provider', async () => {
      const jwtPayload = {};
      const runtime = await initModelRuntimeWithUserPayload('unknown', jwtPayload);

      // 根据实际实现，你可能需要检查是否返回了默认的 runtime 实例，或者是否抛出了异常
      // 例如，如果默认使用 OpenAI:
      expect(runtime['_runtime']).toBeInstanceOf(LobeOpenAI);
    });
  });
});

describe('initModelRuntimeFromDB managed model guard', () => {
  beforeEach(() => {
    enforcementMocks.takeover = true;
  });

  it('falls back to the user runtime when the catalog hits but 平台托管 is not published', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    enforcementMocks.takeover = false;
    vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
      {} as PlatformSecretService,
    );
    // A published, enabled catalog provider with an allowlist that would reject every model:
    // without the enforcement gate this produced PLATFORM_AI_MODEL_NOT_PUBLISHED on chat.
    const resolveSpy = vi
      .spyOn(AiCatalogExecutionResolver.prototype, 'resolveProviderExecutionConfig')
      .mockResolvedValue({
        allowedModels: [],
        config: {},
        keyVaults: { apiKey: 'platform-secret-must-not-be-used' },
        providerKey: 'openai',
        revision: 1,
        runtimeProvider: 'openai',
      });
    const providerRow = {
      enabled: true,
      fetchOnClient: false,
      id: 'openai',
      keyVaults: null,
      settings: {},
      source: 'builtin',
    };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [providerRow] }) }) }),
    };

    try {
      const runtime = await initModelRuntimeFromDB(db as never, 'user-1', 'openai');
      const providerChat = vi.fn().mockResolvedValue(new Response('ok'));
      runtime['_runtime'] = { chat: providerChat } as never;

      // The platform execution resolver is never consulted, and no allowlist hook is composed.
      expect(resolveSpy).not.toHaveBeenCalled();
      await expect(runtime.chat({ messages: [], model: 'user-own-model' })).resolves.toBeInstanceOf(
        Response,
      );
      expect(providerChat).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      if (previousFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
      else process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
    }
  });

  it("trusts a custom provider's normalized runtimeProvider even when its key is builtin-shaped", async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
      {} as PlatformSecretService,
    );
    vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    ).mockResolvedValue({
      allowedModels: [{ modelKey: 'custom-chat', type: 'chat' }],
      config: {},
      keyVaults: { apiKey: 'custom-openai-secret' },
      providerKey: 'azure',
      revision: 1,
      runtimeProvider: 'openai',
    });

    try {
      const runtime = await initModelRuntimeFromDB({} as never, 'user-1', 'azure');
      expect(runtime['_runtime']).toBeInstanceOf(LobeOpenAI);
      expect(runtime['_runtime']).not.toBeInstanceOf(LobeAzureOpenAI);
    } finally {
      vi.restoreAllMocks();
      if (previousFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
      else process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
    }
  });

  it('wires the published-model guard before chat and embeddings provider calls', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
      {} as PlatformSecretService,
    );
    vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    ).mockResolvedValue({
      allowedModels: [
        { modelKey: 'allow-chat', type: 'chat' },
        { modelKey: 'allow-embedding', type: 'embedding' },
      ],
      config: {},
      keyVaults: { apiKey: 'managed-runtime-secret' },
      providerKey: 'openai',
      revision: 1,
      runtimeProvider: 'openai',
    });

    try {
      const runtime = await initModelRuntimeFromDB({} as never, 'user-1', 'openai');
      const providerChat = vi.fn().mockResolvedValue(new Response('ok'));
      const providerEmbeddings = vi.fn().mockResolvedValue([[1]]);
      runtime['_runtime'] = { chat: providerChat, embeddings: providerEmbeddings } as never;

      await expect(runtime.chat({ messages: [], model: 'deny-chat' })).rejects.toMatchObject({
        errorType: 'PLATFORM_AI_MODEL_NOT_PUBLISHED',
      });
      await expect(
        runtime.embeddings({ input: 'blocked', model: 'deny-embedding' }),
      ).rejects.toMatchObject({ errorType: 'PLATFORM_AI_MODEL_NOT_PUBLISHED' });
      expect(providerChat).not.toHaveBeenCalled();
      expect(providerEmbeddings).not.toHaveBeenCalled();

      await runtime.chat({ messages: [], model: 'allow-chat' });
      await runtime.embeddings({ input: 'allowed', model: 'allow-embedding' });
      expect(providerChat).toHaveBeenCalledOnce();
      expect(providerEmbeddings).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      if (previousFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
      else process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
    }
  });

  it('preserves the exact upstream no-allowlist path while managed AI is disabled', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    // Managed AI is on by default now, so "disabled" must be stated explicitly.
    process.env.ENABLE_PLATFORM_MANAGED_AI = '0';
    const providerRow = {
      enabled: true,
      fetchOnClient: false,
      id: 'openai',
      keyVaults: null,
      settings: {},
      source: 'builtin',
    };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [providerRow] }),
        }),
      }),
    };

    try {
      const runtime = await initModelRuntimeFromDB(db as never, 'user-1', 'openai');
      const providerChat = vi.fn().mockResolvedValue(new Response('ok'));
      runtime['_runtime'] = { chat: providerChat } as never;

      await expect(
        runtime.chat({ messages: [], model: 'not-in-platform-catalog' }),
      ).resolves.toBeInstanceOf(Response);
      expect(providerChat).toHaveBeenCalledOnce();
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
      else process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
    }
  });

  it('uses the platform path when the catalog resolves the provider (hit)', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
      {} as PlatformSecretService,
    );
    const resolveSpy = vi
      .spyOn(AiCatalogExecutionResolver.prototype, 'resolveProviderExecutionConfig')
      .mockResolvedValue({
        allowedModels: [{ modelKey: 'managed-chat', type: 'chat' }],
        config: {},
        keyVaults: { apiKey: 'platform-secret', baseURL: 'https://platform.example/v1' },
        providerKey: 'openai',
        revision: 2,
        runtimeProvider: 'openai',
      });

    try {
      // Empty db would fail the user path — success + platform baseURL proves platform hit.
      const runtime = await initModelRuntimeFromDB({} as never, 'user-1', 'openai');
      expect(runtime['_runtime']).toBeInstanceOf(LobeOpenAI);
      expect(runtime['_runtime'].baseURL).toBe('https://platform.example/v1');
      expect(resolveSpy).toHaveBeenCalledOnce();

      // Platform allowlist hooks must be present.
      const providerChat = vi.fn().mockResolvedValue(new Response('ok'));
      runtime['_runtime'] = { chat: providerChat } as never;
      await expect(runtime.chat({ messages: [], model: 'deny-chat' })).rejects.toMatchObject({
        errorType: 'PLATFORM_AI_MODEL_NOT_PUBLISHED',
      });
      expect(providerChat).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      if (previousFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
      else process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
    }
  });

  it('falls back to the user config path on PLATFORM_NOT_FOUND (no platform hooks)', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
      {} as PlatformSecretService,
    );
    const notFound = Object.assign(new Error('PLATFORM_NOT_FOUND'), {
      code: 'PLATFORM_NOT_FOUND',
    });
    vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    ).mockRejectedValue(notFound);

    // User self-built provider row (BYOK). keyVaults null → empty secrets (env fallback ok).
    const providerRow = {
      checkModel: null,
      config: { enableResponseApi: true },
      description: null,
      enabled: true,
      fetchOnClient: false,
      id: 'oai',
      keyVaults: null,
      logo: null,
      name: 'oai',
      settings: { sdkType: 'openai' },
      source: 'custom',
    };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [providerRow] }),
        }),
      }),
    };

    try {
      const runtime = await initModelRuntimeFromDB(db as never, 'user-1', 'oai');
      expect(runtime['_runtime']).toBeInstanceOf(LobeOpenAI);

      // Fallback must NOT attach platform allowlist hooks — arbitrary models still work.
      const providerChat = vi.fn().mockResolvedValue(new Response('ok'));
      runtime['_runtime'] = { chat: providerChat } as never;
      await expect(
        runtime.chat({ messages: [], model: 'any-custom-model' }),
      ).resolves.toBeInstanceOf(Response);
      expect(providerChat).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      if (previousFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
      else process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
    }
  });

  it('rethrows non-PLATFORM_NOT_FOUND platform errors without user fallback', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
      {} as PlatformSecretService,
    );
    const secretError = Object.assign(new Error('PLATFORM_SECRET_REQUIRED'), {
      code: 'PLATFORM_SECRET_REQUIRED',
    });
    vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    ).mockRejectedValue(secretError);

    try {
      // Empty db would produce a different failure if user fallback ran — expect original error.
      await expect(initModelRuntimeFromDB({} as never, 'user-1', 'openai')).rejects.toMatchObject({
        code: 'PLATFORM_SECRET_REQUIRED',
      });
    } finally {
      vi.restoreAllMocks();
      if (previousFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
      else process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
    }
  });

  it.each([
    { enableResponseApi: true, expected: 'responses' as const },
    { enableResponseApi: false, expected: 'chatCompletion' as const },
  ])(
    'injects apiMode=$expected from published enableResponseApi=$enableResponseApi',
    async ({ enableResponseApi, expected }) => {
      const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
      process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
      vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
        {} as PlatformSecretService,
      );
      vi.spyOn(
        AiCatalogExecutionResolver.prototype,
        'resolveProviderExecutionConfig',
      ).mockResolvedValue({
        allowedModels: [{ modelKey: 'allow-chat', type: 'chat' }],
        config: { enableResponseApi },
        keyVaults: { apiKey: 'managed-runtime-secret' },
        providerKey: 'openai',
        revision: 1,
        runtimeProvider: 'openai',
      });

      try {
        const runtime = await initModelRuntimeFromDB({} as never, 'user-1', 'openai');
        const providerChat = vi.fn().mockResolvedValue(new Response('ok'));
        runtime['_runtime'] = { chat: providerChat } as never;

        await runtime.chat({ messages: [], model: 'allow-chat' });
        expect(providerChat).toHaveBeenCalledWith(
          expect.objectContaining({ apiMode: expected, model: 'allow-chat' }),
          expect.anything(),
        );

        // Caller-supplied apiMode wins over the managed default.
        providerChat.mockClear();
        await runtime.chat({
          apiMode: 'chatCompletion',
          messages: [],
          model: 'allow-chat',
        });
        expect(providerChat).toHaveBeenCalledWith(
          expect.objectContaining({ apiMode: 'chatCompletion' }),
          expect.anything(),
        );
      } finally {
        vi.restoreAllMocks();
        if (previousFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
        else process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
      }
    },
  );

  it('injects apiMode on exact-revision managed execution', async () => {
    vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
      {} as PlatformSecretService,
    );
    vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfigAtRevision',
    ).mockResolvedValue({
      allowedModels: [{ modelKey: 'pin-chat', type: 'chat' }],
      config: { enableResponseApi: true },
      keyVaults: { apiKey: 'exact-revision-secret' },
      providerKey: 'openai',
      revision: 7,
      runtimeProvider: 'openai',
    });

    try {
      const runtime = await initPlatformExactModelRuntime({} as never, 'user-1', {
        modelKey: 'pin-chat',
        providerChecksum: 'checksum',
        providerKey: 'openai',
        providerRevision: 7,
      });
      const providerChat = vi.fn().mockResolvedValue(new Response('ok'));
      runtime['_runtime'] = { chat: providerChat } as never;

      await runtime.chat({ messages: [], model: 'pin-chat' });
      expect(providerChat).toHaveBeenCalledWith(
        expect.objectContaining({ apiMode: 'responses', model: 'pin-chat' }),
        expect.anything(),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('initModelRuntimeFromDB wrapModelRuntime seam', () => {
  const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
    else process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
  });

  it('wraps the platform runtime exactly once', async () => {
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
      {} as PlatformSecretService,
    );
    vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    ).mockResolvedValue({
      allowedModels: [{ modelKey: 'allow-chat', type: 'chat' }],
      config: {},
      keyVaults: { apiKey: 'managed-runtime-secret' },
      providerKey: 'openai',
      revision: 1,
      runtimeProvider: 'openai',
    });
    const wrap = vi.spyOn(platformAiRuntimeBridge, 'wrapPlatformModelRuntime');

    await initModelRuntimeFromDB({} as never, 'user-1', 'openai');

    expect(wrap).toHaveBeenCalledOnce();
    expect(wrap.mock.calls[0][1]).toMatchObject({
      provider: 'openai',
      skipModeration: undefined,
      userId: 'user-1',
    });
  });

  it('wraps the BYOK fallback exactly once (PLATFORM_NOT_FOUND)', async () => {
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
      {} as PlatformSecretService,
    );
    vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    ).mockRejectedValue(
      Object.assign(new Error('PLATFORM_NOT_FOUND'), { code: 'PLATFORM_NOT_FOUND' }),
    );
    const wrap = vi.spyOn(platformAiRuntimeBridge, 'wrapPlatformModelRuntime');
    const providerRow = {
      enabled: true,
      fetchOnClient: false,
      id: 'openai',
      keyVaults: null,
      settings: {},
      source: 'builtin',
    };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [providerRow] }) }) }),
    };

    await initModelRuntimeFromDB(db as never, 'user-1', 'openai');

    expect(wrap).toHaveBeenCalledOnce();
  });

  it('forwards skipModeration so the wrap is a no-op', async () => {
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
      {} as PlatformSecretService,
    );
    vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    ).mockResolvedValue({
      allowedModels: [{ modelKey: 'allow-chat', type: 'chat' }],
      config: {},
      keyVaults: { apiKey: 'managed-runtime-secret' },
      providerKey: 'openai',
      revision: 1,
      runtimeProvider: 'openai',
    });
    const wrap = vi.spyOn(platformAiRuntimeBridge, 'wrapPlatformModelRuntime');

    const runtime = await initModelRuntimeFromDB({} as never, 'user-1', 'openai', undefined, {
      skipModeration: true,
    });

    expect(wrap).toHaveBeenCalledOnce();
    expect(wrap.mock.calls[0][1]).toMatchObject({ skipModeration: true });
    // skipModeration short-circuits before Proxy construction.
    expect(runtime).toBeInstanceOf(ModelRuntime);
  });

  it('wraps initPlatformExactModelRuntime once; cross-provider downgrade inits via skipModeration', async () => {
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
      {} as PlatformSecretService,
    );
    vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfigAtRevision',
    ).mockResolvedValue({
      allowedModels: [{ modelKey: 'pin-chat', type: 'chat' }],
      config: {},
      keyVaults: { apiKey: 'exact-revision-secret' },
      providerKey: 'openai',
      revision: 7,
      runtimeProvider: 'openai',
    });

    const wrap = vi
      .spyOn(platformAiRuntimeBridge, 'wrapPlatformModelRuntime')
      .mockImplementation((runtime, wrapCtx) =>
        wrapModelRuntimeWithModeration(runtime, wrapCtx, {
          evaluate: async () => ({
            downgradeTarget: { model: 'haiku', provider: 'anthropic' },
            effectiveAction: 'downgrade',
            skipped: false,
          }),
          extractPromptText: () => 'hello',
          getSnapshot: async () => ({
            config: { messages: { showCategoryToUser: true }, mode: 'enforce' },
          }),
          initRuntime: createDefaultModerationRuntimeDeps(wrapCtx).initRuntime,
          record: vi.fn(),
        }),
      );

    const runtime = await initPlatformExactModelRuntime({} as never, 'user-1', {
      modelKey: 'pin-chat',
      providerChecksum: 'checksum',
      providerKey: 'openai',
      providerRevision: 7,
    });
    expect(wrap).toHaveBeenCalledOnce();

    const modelRuntimeModule = await import('./index');
    const initSpy = vi.spyOn(modelRuntimeModule, 'initModelRuntimeFromDB').mockResolvedValue({
      chat: vi.fn().mockResolvedValue(new Response('downgraded')),
    } as never);

    await runtime.chat({
      messages: [{ content: 'hello', role: 'user' }],
      model: 'pin-chat',
    });

    expect(initSpy).toHaveBeenCalledWith(expect.anything(), 'user-1', 'anthropic', undefined, {
      skipModeration: true,
    });
  });
});

describe('resolveManagedChatApiMode', () => {
  it('maps explicit booleans and leaves unset undefined', () => {
    expect(resolveManagedChatApiMode(true)).toBe('responses');
    expect(resolveManagedChatApiMode(false)).toBe('chatCompletion');
    expect(resolveManagedChatApiMode(undefined)).toBeUndefined();
    expect(resolveManagedChatApiMode(null)).toBeUndefined();
  });
});

describe('hasModelRuntimeEnvironmentFallback SuperGrok', () => {
  it('never treats SUPERGROK_API_KEY as a valid environment fallback', () => {
    expect(
      hasModelRuntimeEnvironmentFallback(ModelProvider.SuperGrok, {
        SUPERGROK_API_KEY: 'would-have-been-false-ready',
      }),
    ).toBe(false);
  });
});

describe('hasModelRuntimeEnvironmentFallback ChatGPT', () => {
  it('never treats CHATGPT_API_KEY as a valid environment fallback', () => {
    expect(
      hasModelRuntimeEnvironmentFallback(ModelProvider.ChatGPT, {
        CHATGPT_API_KEY: 'would-have-been-false-ready',
      }),
    ).toBe(false);
  });
});

describe('hasModelRuntimeEnvironmentFallback ChatGPTWeb', () => {
  it('never treats CHATGPTWEB_API_KEY as a valid environment fallback', () => {
    expect(
      hasModelRuntimeEnvironmentFallback(ModelProvider.ChatGPTWeb, {
        CHATGPTWEB_API_KEY: 'would-have-been-false-ready',
      }),
    ).toBe(false);
  });
});

describe('buildPayloadFromKeyVaults ChatGPTWeb contract', () => {
  it('forwards the OAuth access token, account id and the STABLE device id', () => {
    expect(buildPayloadFromKeyVaults({ apiKey: 'sk-ignored' }, ModelProvider.ChatGPTWeb)).toEqual({
      apiKey: undefined,
      chatgptAccountId: undefined,
      chatgptDeviceId: undefined,
      runtimeProvider: ModelProvider.ChatGPTWeb,
    });
    expect(
      buildPayloadFromKeyVaults(
        {
          oauthAccessToken: 'oauth-token-value',
          oauthAccountId: 'account-id',
          oauthDeviceId: 'device-id',
        },
        ModelProvider.ChatGPTWeb,
      ),
    ).toEqual({
      apiKey: 'oauth-token-value',
      chatgptAccountId: 'account-id',
      chatgptDeviceId: 'device-id',
      runtimeProvider: ModelProvider.ChatGPTWeb,
    });
  });
});

describe('ChatGPT Web transport injection', () => {
  const payload: ClientSecretPayload = {
    apiKey: 'oauth-token-value',
    chatgptAccountId: 'account-id',
    chatgptDeviceId: 'device-id',
    runtimeProvider: ModelProvider.ChatGPTWeb,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * chatgpt.com is behind Cloudflare bot-fight and 403s any plain-Node TLS fingerprint,
   * so this runtime cannot use the default transport. Asserted at the single construction
   * seam every server path (user BYOK, platform-managed, exact-revision pin) goes through.
   */
  it('injects the impersonated fetch and forwards the identity params', () => {
    const spy = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as unknown as ModelRuntime);

    initModelRuntimeWithUserPayload(ModelProvider.ChatGPTWeb, payload);

    const params = spy.mock.calls[0][1] as Record<string, unknown>;
    expect(params.apiKey).toBe('oauth-token-value');
    expect(params.chatgptAccountId).toBe('account-id');
    expect(params.chatgptDeviceId).toBe('device-id');
    expect(typeof params.fetch).toBe('function');
  });

  it('lets an explicit transport win (the connection probe supplies its own)', () => {
    const spy = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as unknown as ModelRuntime);
    const probeFetch = vi.fn() as unknown as typeof fetch;

    initModelRuntimeWithUserPayload(ModelProvider.ChatGPTWeb, payload, { fetch: probeFetch });

    expect((spy.mock.calls[0][1] as Record<string, unknown>).fetch).toBe(probeFetch);
  });

  it('leaves every other provider on its own default transport', () => {
    const spy = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as unknown as ModelRuntime);

    initModelRuntimeWithUserPayload(ModelProvider.OpenAI, {
      apiKey: 'sk-1',
      runtimeProvider: ModelProvider.OpenAI,
    });

    expect((spy.mock.calls[0][1] as Record<string, unknown>).fetch).toBeUndefined();
  });
});

describe('buildPayloadFromKeyVaults SuperGrok contract', () => {
  it('only accepts oauthAccessToken — plain apiKey does not become a usable bearer', () => {
    expect(buildPayloadFromKeyVaults({ apiKey: 'sk-ignored' }, ModelProvider.SuperGrok)).toEqual({
      apiKey: undefined,
      runtimeProvider: ModelProvider.SuperGrok,
    });
    expect(
      buildPayloadFromKeyVaults({ oauthAccessToken: 'oauth-token-value' }, ModelProvider.SuperGrok),
    ).toEqual({
      apiKey: 'oauth-token-value',
      runtimeProvider: ModelProvider.SuperGrok,
    });
  });
});

describe('buildPayloadFromKeyVaults ChatGPT contract', () => {
  it('forwards only the OAuth access token and account id required by Codex', () => {
    expect(buildPayloadFromKeyVaults({ apiKey: 'sk-ignored' }, ModelProvider.ChatGPT)).toEqual({
      apiKey: undefined,
      chatgptAccountId: undefined,
      runtimeProvider: ModelProvider.ChatGPT,
    });
    expect(
      buildPayloadFromKeyVaults(
        { oauthAccessToken: 'oauth-token-value', oauthAccountId: 'account-id' },
        ModelProvider.ChatGPT,
      ),
    ).toEqual({
      apiKey: 'oauth-token-value',
      chatgptAccountId: 'account-id',
      runtimeProvider: ModelProvider.ChatGPT,
    });
  });
});

/**
 * Test cases for buildPayloadFromKeyVaults function
 * This function builds ClientSecretPayload based on runtimeProvider (sdkType)
 * to ensure provider-specific fields are correctly forwarded
 */
describe('buildPayloadFromKeyVaults', () => {
  describe('should build payload with correct fields based on runtimeProvider', () => {
    it('OpenAI compatible: returns apiKey, baseURL and runtimeProvider', () => {
      const keyVaults = {
        apiKey: 'test-api-key',
        baseURL: 'https://custom-endpoint.com/v1',
      };
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.OpenAI);

      expect(payload).toEqual({
        apiKey: 'test-api-key',
        baseURL: 'https://custom-endpoint.com/v1',
        runtimeProvider: ModelProvider.OpenAI,
      });
    });

    it('Azure: returns apiKey, baseURL and runtimeProvider', () => {
      const keyVaults = {
        apiKey: 'azure-api-key',
        baseURL: 'https://my-azure.openai.azure.com',
        apiVersion: '2024-06-01',
        endpoint: 'https://fallback-endpoint.com',
      };
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.Azure);

      expect(payload).toEqual({
        apiKey: 'azure-api-key',
        baseURL: 'https://my-azure.openai.azure.com',
        runtimeProvider: ModelProvider.Azure,
      });
    });

    it('Azure: uses endpoint as fallback when baseURL is not provided', () => {
      const keyVaults = {
        apiKey: 'azure-api-key',
        endpoint: 'https://fallback-endpoint.com',
        apiVersion: '2024-06-01',
      };
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.Azure);

      expect(payload.baseURL).toBe('https://fallback-endpoint.com');
    });

    it('Cloudflare: returns apiKey, cloudflareBaseURLOrAccountID and runtimeProvider', () => {
      const keyVaults = {
        apiKey: 'cloudflare-api-key',
        baseURLOrAccountID: 'my-account-id',
      };
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.Cloudflare);

      expect(payload).toEqual({
        apiKey: 'cloudflare-api-key',
        cloudflareBaseURLOrAccountID: 'my-account-id',
        runtimeProvider: ModelProvider.Cloudflare,
      });
    });

    it('Bedrock: returns AWS credentials and runtimeProvider', () => {
      const keyVaults = {
        accessKeyId: 'aws-access-key',
        secretAccessKey: 'aws-secret-key',
        region: 'us-east-1',
        sessionToken: 'session-token',
      };
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.Bedrock);

      expect(payload).toEqual({
        apiKey: undefined,
        awsAccessKeyId: 'aws-access-key',
        awsRegion: 'us-east-1',
        awsSecretAccessKey: 'aws-secret-key',
        awsSessionToken: 'session-token',
        runtimeProvider: ModelProvider.Bedrock,
      });
    });

    it('Bedrock: returns API key and runtimeProvider', () => {
      const keyVaults = {
        apiKey: 'bedrock-api-key',
        region: 'us-east-1',
      };
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.Bedrock);

      expect(payload).toEqual({
        apiKey: 'bedrock-api-key',
        awsAccessKeyId: undefined,
        awsRegion: 'us-east-1',
        awsSecretAccessKey: undefined,
        awsSessionToken: undefined,
        runtimeProvider: ModelProvider.Bedrock,
      });
    });

    it('Ollama: returns baseURL and runtimeProvider', () => {
      const keyVaults = {
        baseURL: 'http://localhost:11434',
      };
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.Ollama);

      expect(payload).toEqual({
        baseURL: 'http://localhost:11434',
        runtimeProvider: ModelProvider.Ollama,
      });
    });

    it('VertexAI: returns apiKey, baseURL, vertexAIRegion and runtimeProvider', () => {
      const keyVaults = {
        apiKey: 'vertex-credentials-json',
        baseURL: 'https://vertex-endpoint.com',
        region: 'us-central1',
      };
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.VertexAI);

      expect(payload).toEqual({
        apiKey: 'vertex-credentials-json',
        baseURL: 'https://vertex-endpoint.com',
        runtimeProvider: ModelProvider.VertexAI,
        vertexAIRegion: 'us-central1',
      });
    });

    it('ComfyUI: returns all auth fields and runtimeProvider', () => {
      const keyVaults = {
        apiKey: 'comfyui-api-key',
        authType: 'bearer',
        baseURL: 'http://localhost:8188',
        customHeaders: { 'X-Custom': 'header' },
        password: 'pass',
        username: 'user',
      } as const;
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.ComfyUI);

      expect(payload).toEqual({
        apiKey: 'comfyui-api-key',
        authType: 'bearer',
        baseURL: 'http://localhost:8188',
        customHeaders: { 'X-Custom': 'header' },
        password: 'pass',
        runtimeProvider: ModelProvider.ComfyUI,
        username: 'user',
      });
    });

    it('Unknown provider: falls back to default with apiKey, baseURL and runtimeProvider', () => {
      const keyVaults = {
        apiKey: 'unknown-api-key',
        baseURL: 'https://unknown-endpoint.com',
      };
      const payload = buildPayloadFromKeyVaults(keyVaults, 'unknown-provider');

      expect(payload).toEqual({
        apiKey: 'unknown-api-key',
        baseURL: 'https://unknown-endpoint.com',
        runtimeProvider: 'unknown-provider',
      });
    });
  });

  describe('custom provider with sdkType should include provider-specific fields', () => {
    it('custom provider with Azure sdkType keeps apiKey and baseURL only', () => {
      const keyVaults = {
        apiKey: 'custom-azure-key',
        baseURL: 'https://custom-azure.openai.azure.com',
        apiVersion: '2024-06-01',
      };
      // Simulates a custom provider where runtimeProvider is resolved to 'azure'
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.Azure);

      expect(payload.apiKey).toBe('custom-azure-key');
      expect(payload.baseURL).toBe('https://custom-azure.openai.azure.com');
      expect(payload.runtimeProvider).toBe(ModelProvider.Azure);
    });

    it('custom provider with Cloudflare sdkType includes cloudflareBaseURLOrAccountID', () => {
      const keyVaults = {
        apiKey: 'custom-cloudflare-key',
        baseURLOrAccountID: 'custom-account-id',
      };
      // Simulates a custom provider where runtimeProvider is resolved to 'cloudflare'
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.Cloudflare);

      expect(payload.cloudflareBaseURLOrAccountID).toBe('custom-account-id');
      expect(payload.runtimeProvider).toBe(ModelProvider.Cloudflare);
    });

    it('custom provider with Bedrock sdkType includes AWS credentials', () => {
      const keyVaults = {
        accessKeyId: 'custom-aws-id',
        secretAccessKey: 'custom-aws-secret',
        region: 'eu-west-1',
      };
      // Simulates a custom provider where runtimeProvider is resolved to 'bedrock'
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.Bedrock);

      expect(payload.awsAccessKeyId).toBe('custom-aws-id');
      expect(payload.awsSecretAccessKey).toBe('custom-aws-secret');
      expect(payload.awsRegion).toBe('eu-west-1');
      expect(payload.runtimeProvider).toBe(ModelProvider.Bedrock);
    });

    it('custom provider with Ollama sdkType includes baseURL', () => {
      const keyVaults = {
        baseURL: 'http://custom-ollama:11434',
      };
      // Simulates a custom provider where runtimeProvider is resolved to 'ollama'
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.Ollama);

      expect(payload.baseURL).toBe('http://custom-ollama:11434');
      expect(payload.runtimeProvider).toBe(ModelProvider.Ollama);
    });

    it('custom provider with VertexAI sdkType includes vertexAIRegion', () => {
      const keyVaults = {
        apiKey: 'custom-vertex-creds',
        region: 'asia-northeast1',
      };
      // Simulates a custom provider where runtimeProvider is resolved to 'vertexai'
      const payload = buildPayloadFromKeyVaults(keyVaults, ModelProvider.VertexAI);

      expect(payload.vertexAIRegion).toBe('asia-northeast1');
      expect(payload.runtimeProvider).toBe(ModelProvider.VertexAI);
    });
  });
});
