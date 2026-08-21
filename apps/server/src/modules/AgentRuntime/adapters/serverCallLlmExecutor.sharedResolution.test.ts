/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AgentOperationModelModule from '@/database/models/agentOperation';
import * as ContextEngineering from '@/server/modules/Mecha/ContextEngineering';
import type * as PlatformAiRuntimeBridge from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';

import type { RuntimeExecutorContext } from '../context';
import { callLlm } from './serverCallLlmExecutor';

const {
  findPlatformOperationRef,
  getPlatformAiTakeoverFlags,
  initModelRuntimeFromDB,
  initPlatformExactModelRuntime,
  isPlatformManagedAiEnabled,
  resolvePlatformAiExecutionConfig,
  resolvePlatformAiExecutionConfigAtRevision,
} = vi.hoisted(() => ({
  findPlatformOperationRef: vi.fn(),
  getPlatformAiTakeoverFlags: vi.fn(async () => ({ models: false, providers: true })),
  initModelRuntimeFromDB: vi.fn(),
  initPlatformExactModelRuntime: vi.fn(),
  isPlatformManagedAiEnabled: vi.fn(() => true),
  resolvePlatformAiExecutionConfig: vi.fn(),
  resolvePlatformAiExecutionConfigAtRevision: vi.fn(),
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB,
  initPlatformExactModelRuntime,
  rememberModelRuntimeConversationStartMs: vi.fn(() => 1_700_000_000_000),
}));

vi.mock('@/server/modules/ModelRuntime/platformAiRuntimeBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof PlatformAiRuntimeBridge>()),
  getPlatformAiTakeoverFlags,
  isPlatformManagedAiEnabled,
  resolvePlatformAiExecutionConfig,
  resolvePlatformAiExecutionConfigAtRevision,
}));

vi.mock('@/database/models/agentOperation', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentOperationModelModule>()),
  AgentOperationModel: class {
    findPlatformOperationRef = findPlatformOperationRef;
  },
}));

vi.mock('./serverCallLlmContextHints', () => ({
  resolveServerCallLlmContextHints: vi.fn(async ({ llmPayload }) => ({
    capabilities: {},
    messagesForContext: llmPayload.messages,
    modelDisplayName: 'Composer 2.5',
    modelKnowledgeCutoff: '2024-06',
    preserveThinkingForPayload: false,
    resolvedExtendParams: undefined,
    shouldReplayAssistantReasoning: false,
  })),
}));

vi.mock('@/config/composio', () => ({
  composioEnv: { COMPOSIO_API_KEY: undefined },
  getComposioConfig: vi.fn(),
  getServerComposioApiKey: vi.fn().mockReturnValue(undefined),
}));

vi.mock('@/envs/file', () => ({
  fileEnv: { NEXT_PUBLIC_S3_FILE_PATH: 'files' },
}));

vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({
    deleteUserFileRecord: vi.fn(),
    getFileAccessUrl: vi.fn(),
    uploadBase64: vi.fn(),
    uploadFromBuffer: vi.fn(),
  })),
}));

vi.mock('@/business/server/recordModelCompletionFailure', () => ({
  recordModelCompletionFailure: vi.fn(),
}));

const cursorExecution = {
  allowedModels: [{ modelKey: 'composer-2.5', type: 'chat' }],
  config: {},
  keyVaults: { apiKey: 'platform-cursor' },
  providerKey: 'corp-cursor',
  revision: 1,
  runtimeProvider: 'cursor',
};

const createState = () =>
  ({
    cost: { calculatedAt: new Date().toISOString(), currency: 'USD', llm: { total: 0 }, total: 0 },
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    maxSteps: 10,
    messages: [],
    metadata: { platformStartClassification: 'ordinary' },
    modelRuntimeConfig: { model: 'composer-2.5', provider: 'corp-cursor' },
    operationId: 'op-shared',
    status: 'running',
    stepCount: 0,
    toolManifestMap: {},
    usage: { llm: { tokens: { total: 0 } }, total: 0 },
  }) as never;

describe('callLlm — shared catalog resolution', () => {
  let ctx: RuntimeExecutorContext;
  let chat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    isPlatformManagedAiEnabled.mockReturnValue(true);
    getPlatformAiTakeoverFlags.mockResolvedValue({ models: false, providers: true });
    findPlatformOperationRef.mockResolvedValue({
      classification: 'ordinary',
      isPlatformOperation: false,
      modelPin: null,
      platformStart: null,
    });
    chat = vi.fn().mockImplementation(async (_payload: unknown, options: { callback?: any }) => {
      await options?.callback?.onText?.('done');
      return new Response('done');
    });
    initModelRuntimeFromDB.mockResolvedValue({ chat });
    initPlatformExactModelRuntime.mockResolvedValue({ chat });

    ctx = {
      agentConfig: {
        chatConfig: {},
        files: [],
        knowledgeBases: [],
        systemRole: 'You are a custom coding agent.',
      },
      loadAgentState: vi.fn().mockResolvedValue({
        metadata: { platformStartClassification: 'ordinary' },
      }),
      messageModel: {
        create: vi.fn().mockResolvedValue({ id: 'asst-1' }),
        findById: vi.fn().mockResolvedValue({ id: 'parent-1' }),
        update: vi.fn().mockResolvedValue({}),
      },
      operationId: 'op-shared',
      serverDB: {},
      stepIndex: 0,
      streamManager: {
        publishStreamChunk: vi.fn().mockResolvedValue('chunk'),
        publishStreamEvent: vi.fn().mockResolvedValue('event'),
      },
      userId: 'user-a',
    } as unknown as RuntimeExecutorContext;
  });

  it('retries a transient first catalog lookup and completes with web-app gating from the shared result', async () => {
    resolvePlatformAiExecutionConfig
      .mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(cursorExecution);

    const engineSpy = vi.spyOn(ContextEngineering, 'serverMessagesEngine');

    await callLlm(ctx)(
      {
        payload: {
          messages: [{ content: 'hello', role: 'user' }],
          model: 'composer-2.5',
          provider: 'corp-cursor',
        },
        type: 'call_llm',
      } as never,
      createState(),
    );

    expect(resolvePlatformAiExecutionConfig).toHaveBeenCalledTimes(2);
    expect(resolvePlatformAiExecutionConfigAtRevision).not.toHaveBeenCalled();
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
    expect(initModelRuntimeFromDB).toHaveBeenCalledTimes(1);
    expect(initModelRuntimeFromDB).toHaveBeenCalledWith(
      ctx.serverDB,
      'user-a',
      'corp-cursor',
      undefined,
      expect.objectContaining({ executionConfig: cursorExecution }),
    );

    expect(engineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'corp-cursor',
        runtimeProvider: 'cursor',
        systemRole: 'You are a custom coding agent.',
      }),
    );

    const chatMessages = chat.mock.calls[0][0].messages as Array<{ content: string; role: string }>;
    expect(chatMessages[0]).toEqual({
      content: 'You are a custom coding agent.',
      role: 'system',
    });
    expect(chatMessages.some((message) => message.content.includes('Current date:'))).toBe(false);
    expect(chatMessages.some((message) => message.content.includes('Current model:'))).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('selects the user runtime when managed AI is on but provider takeover is off', async () => {
    getPlatformAiTakeoverFlags.mockResolvedValue({ models: false, providers: false });
    resolvePlatformAiExecutionConfig.mockResolvedValue(cursorExecution);

    const engineSpy = vi.spyOn(ContextEngineering, 'serverMessagesEngine');

    await callLlm(ctx)(
      {
        payload: {
          messages: [{ content: 'hello', role: 'user' }],
          model: 'gpt-4o',
          provider: 'openai',
        },
        type: 'call_llm',
      } as never,
      createState(),
    );

    expect(resolvePlatformAiExecutionConfig).not.toHaveBeenCalled();
    expect(resolvePlatformAiExecutionConfigAtRevision).not.toHaveBeenCalled();
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
    expect(initModelRuntimeFromDB).toHaveBeenCalledWith(
      ctx.serverDB,
      'user-a',
      'openai',
      undefined,
      expect.objectContaining({ executionConfig: null }),
    );
    expect(engineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        runtimeProvider: undefined,
      }),
    );
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
