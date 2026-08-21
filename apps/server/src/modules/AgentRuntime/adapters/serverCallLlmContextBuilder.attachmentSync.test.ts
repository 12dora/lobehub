/**
 * @vitest-environment node
 */
import { sandboxOverLimitUploadPath } from '@lobechat/builtin-tool-cloud-sandbox';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServerCallLlmContext } from './serverCallLlmContextBuilder';

const { createCachedPreSignedUrlForPreview, serverMessagesEngine, syncOverLimitAttachments } =
  vi.hoisted(() => ({
    createCachedPreSignedUrlForPreview: vi.fn(
      async (url: string) => `https://signed.example/${url}`,
    ),
    serverMessagesEngine: vi.fn(async (input: { messages: unknown[] }) => input.messages),
    syncOverLimitAttachments: vi.fn(async (files: Array<{ id: string; name: string }>) =>
      Object.fromEntries(
        files.map((file) => [file.id, sandboxOverLimitUploadPath(file.name, file.id)]),
      ),
    ),
  }));

vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({ serverMessagesEngine }));

vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({
    createCachedPreSignedUrlForPreview,
  })),
}));

vi.mock('@/server/services/sandbox', async () => {
  const attachmentSync = await import('@/server/services/sandbox/attachmentSync');
  return {
    createSandboxService: vi.fn(() => ({
      callTool: vi.fn(),
      syncOverLimitAttachments,
    })),
    selectAttachmentsForSandboxSync: attachmentSync.selectAttachmentsForSandboxSync,
    syncOverLimitAttachmentsIfSandboxEnabled:
      attachmentSync.syncOverLimitAttachmentsIfSandboxEnabled,
  };
});

vi.mock('@/database/models/file', () => ({
  FileModel: vi.fn().mockImplementation(() => ({
    findFilesToInitInSandbox: vi.fn(async () => []),
  })),
}));

vi.mock('./serverCallLlmContextHints', () => ({
  resolveServerCallLlmContextHints: vi.fn(async ({ llmPayload }) => ({
    capabilities: {
      isCanUseAudio: () => false,
      isCanUseFC: () => true,
      isCanUseFiles: () => false,
      isCanUseVideo: () => false,
      isCanUseVision: () => false,
    },
    messagesForContext: llmPayload.messages,
    modelDisplayName: 'Test model',
    preserveThinkingForPayload: false,
    resolvedExtendParams: undefined,
    shouldReplayAssistantReasoning: false,
  })),
}));

const botDocument = {
  content: 'parsed pdf body text',
  fileType: 'application/pdf',
  id: 'file-pdf',
  name: 'doc.pdf',
  size: 40 * 1024 * 1024,
  // Bot/IM ingest stores the S3 key when there is no public URL.
  url: 'files/test-user-id/xxx/doc.pdf',
};

const makeCtx = () => ({
  agentConfig: { chatConfig: {}, files: [], knowledgeBases: [], systemRole: 'sys' },
  operationId: 'op-1',
  serverDB: {},
  stepIndex: 0,
  topicId: 'topic-1',
  tracingContextEngine: vi.fn(),
  userId: 'user-1',
});

const tooling = {
  resolved: {
    enabledToolIds: ['lobe-cloud-sandbox'],
    promptManifestMap: {},
  },
};

describe('buildServerCallLlmContext — over-limit attachment sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncOverLimitAttachments.mockImplementation(
      async (files: Array<{ id: string; name: string }>) =>
        Object.fromEntries(
          files.map((file) => [file.id, sandboxOverLimitUploadPath(file.name, file.id)]),
        ),
    );
  });

  it('signs a bot-originated document storage key and syncs without callTool', async () => {
    await buildServerCallLlmContext({
      ctx: makeCtx() as never,
      llmPayload: {
        messages: [{ content: 'summarize', fileList: [botDocument], role: 'user' }],
      } as never,
      model: 'gpt-4',
      provider: 'openai',
      resolvedExecution: null,
      state: { metadata: { topicId: 'topic-1' } } as never,
      tooling: tooling as never,
    });

    expect(createCachedPreSignedUrlForPreview).toHaveBeenCalledWith(
      'files/test-user-id/xxx/doc.pdf',
    );
    expect(syncOverLimitAttachments).toHaveBeenCalledWith([
      {
        id: 'file-pdf',
        name: 'doc.pdf',
        url: 'https://signed.example/files/test-user-id/xxx/doc.pdf',
      },
    ]);

    const input = serverMessagesEngine.mock.calls[0][0] as {
      fileContext?: {
        omitFileUrlFileIds?: string[];
        sandboxPathByFileId?: Record<string, string>;
      };
    };
    expect(input.fileContext?.sandboxPathByFileId).toEqual({
      'file-pdf': sandboxOverLimitUploadPath('doc.pdf', 'file-pdf'),
    });
    expect(input.fileContext?.omitFileUrlFileIds).toEqual(['file-pdf']);
  });

  it('still omits URLs when every sandbox download fails', async () => {
    syncOverLimitAttachments.mockResolvedValue({});

    await buildServerCallLlmContext({
      ctx: makeCtx() as never,
      llmPayload: {
        messages: [{ content: 'summarize', fileList: [botDocument], role: 'user' }],
      } as never,
      model: 'gpt-4',
      provider: 'openai',
      resolvedExecution: null,
      state: { metadata: { topicId: 'topic-1' } } as never,
      tooling: tooling as never,
    });

    const input = serverMessagesEngine.mock.calls[0][0] as {
      fileContext?: {
        omitFileUrlFileIds?: string[];
        sandboxPathByFileId?: Record<string, string>;
      };
    };
    expect(input.fileContext?.sandboxPathByFileId).toBeUndefined();
    expect(input.fileContext?.omitFileUrlFileIds).toEqual(['file-pdf']);
  });

  it('keeps successful paths and omits URLs for the failed member of a batch', async () => {
    const second = { ...botDocument, id: 'file-zip', name: 'data.zip', url: 'files/user/data.zip' };
    syncOverLimitAttachments.mockResolvedValue({
      'file-pdf': sandboxOverLimitUploadPath('doc.pdf', 'file-pdf'),
    });

    await buildServerCallLlmContext({
      ctx: makeCtx() as never,
      llmPayload: {
        messages: [{ content: 'summarize', fileList: [botDocument, second], role: 'user' }],
      } as never,
      model: 'gpt-4',
      provider: 'openai',
      resolvedExecution: null,
      state: { metadata: { topicId: 'topic-1' } } as never,
      tooling: tooling as never,
    });

    const input = serverMessagesEngine.mock.calls[0][0] as {
      fileContext?: {
        omitFileUrlFileIds?: string[];
        sandboxPathByFileId?: Record<string, string>;
      };
    };
    expect(input.fileContext?.sandboxPathByFileId).toEqual({
      'file-pdf': sandboxOverLimitUploadPath('doc.pdf', 'file-pdf'),
    });
    expect(input.fileContext?.omitFileUrlFileIds).toEqual(['file-pdf', 'file-zip']);
  });
});
