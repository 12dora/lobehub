import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import type { FileService } from '@/server/services/file';
import type { MarketService } from '@/server/services/market';

import { SANDBOX_FILES_INIT_MARKER } from '../bootstrap';
import { SandboxMiddlewareService } from '../service';
import type { SandboxProvider } from '../types';
import { SANDBOX_PUT_FILES_MAX_FILE_BYTES } from '../types';

const findFilesToInitInSandbox = vi.fn();

vi.mock('@/database/models/file', () => ({
  FileModel: vi.fn().mockImplementation(() => ({ findFilesToInitInSandbox })),
}));

const createProvider = (): SandboxProvider =>
  ({
    capabilities: {
      backgroundCommands: true,
      exportFile: true,
      files: true,
      languages: ['python'],
      persistentSession: true,
      shell: true,
      skillScripts: true,
    },
    callTool: vi.fn(async () => ({ result: {}, success: true })),
    exportFileToUploadUrl: vi.fn(),
    kind: 'onlyboxes',
  }) satisfies SandboxProvider;

const createFileService = (): FileService =>
  ({
    createCachedPreSignedUrlForPreview: vi.fn(async () => 'https://download.example.com/x'),
    getFileByteArray: vi.fn(async () => new Uint8Array([1, 2, 3])),
  }) as unknown as FileService;

const baseOptions = () => ({
  fileService: createFileService(),
  marketService: {} as MarketService,
  serverDB: {} as LobeChatDatabase,
  topicId: 'topic-1',
  userId: 'user-1',
});

describe('SandboxMiddlewareService file initialization', () => {
  beforeEach(() => {
    findFilesToInitInSandbox.mockReset();
    findFilesToInitInSandbox.mockResolvedValue([
      { fileType: 'text/csv', id: 'f1', name: 'data.csv', size: 10, url: 'key-1' },
    ]);
  });

  it('syncs uploaded files into the sandbox before the first tool call', async () => {
    const provider = createProvider();
    const service = new SandboxMiddlewareService(provider, baseOptions());

    await service.callTool('listFiles', { directoryPath: '/mnt/data' });

    expect(findFilesToInitInSandbox).toHaveBeenCalledWith('topic-1');
    expect(provider.callTool).toHaveBeenNthCalledWith(
      1,
      'runCommand',
      expect.objectContaining({ command: expect.stringContaining('curl') }),
    );
    expect(provider.callTool).toHaveBeenNthCalledWith(2, 'listFiles', {
      directoryPath: '/mnt/data',
    });
  });

  it('only runs the sync once per service instance', async () => {
    const provider = createProvider();
    const service = new SandboxMiddlewareService(provider, baseOptions());

    await service.callTool('listFiles', {});
    await service.callTool('readFile', { path: '/mnt/data/data.csv' });

    const runCommandCalls = (provider.callTool as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([tool]) => tool === 'runCommand',
    );
    expect(runCommandCalls).toHaveLength(1);
  });

  it('skips the sync when there is no serverDB', async () => {
    const provider = createProvider();
    const service = new SandboxMiddlewareService(provider, {
      ...baseOptions(),
      serverDB: undefined,
    });

    await service.callTool('listFiles', {});

    expect(findFilesToInitInSandbox).not.toHaveBeenCalled();
    expect(provider.callTool).toHaveBeenCalledTimes(1);
    expect(provider.callTool).toHaveBeenCalledWith('listFiles', {});
  });

  it('does not sync when there are no uploaded files', async () => {
    findFilesToInitInSandbox.mockResolvedValue([]);
    const provider = createProvider();
    const service = new SandboxMiddlewareService(provider, baseOptions());

    await service.callTool('listFiles', {});

    expect(provider.callTool).toHaveBeenCalledTimes(1);
    expect(provider.callTool).toHaveBeenCalledWith('listFiles', {});
  });

  it('never blocks the tool call when the sync fails', async () => {
    findFilesToInitInSandbox.mockRejectedValue(new Error('db down'));
    const provider = createProvider();
    const service = new SandboxMiddlewareService(provider, baseOptions());

    await expect(service.callTool('listFiles', {})).resolves.toMatchObject({ success: true });
    expect(provider.callTool).toHaveBeenCalledWith('listFiles', {});
  });

  it('skips files exceeding the size cap, matching what the prompt advertises', async () => {
    findFilesToInitInSandbox.mockResolvedValue([
      {
        fileType: 'application/zip',
        id: 'big',
        name: 'huge.zip',
        size: 200 * 1024 * 1024,
        url: 'k',
      },
    ]);
    const provider = createProvider();
    const service = new SandboxMiddlewareService(provider, baseOptions());

    await service.callTool('listFiles', {});

    // oversized file is filtered out → nothing to download → only the real tool runs
    expect(provider.callTool).toHaveBeenCalledTimes(1);
    expect(provider.callTool).toHaveBeenCalledWith('listFiles', {});
  });

  it('pushes bytes through putFiles instead of curling a presigned URL', async () => {
    const putFiles = vi.fn(async (files: Array<{ path: string }>) => ({
      failed: [],
      written: files.map((file) => file.path),
    }));
    const provider = createProvider();
    Object.assign(provider, { putFiles });
    const options = baseOptions();
    const service = new SandboxMiddlewareService(provider, options);

    await service.callTool('listFiles', { directoryPath: '/mnt/data' });

    expect(options.fileService.createCachedPreSignedUrlForPreview).not.toHaveBeenCalled();
    expect(options.fileService.getFileByteArray).toHaveBeenCalledWith('key-1');
    expect(putFiles).toHaveBeenCalledTimes(1);
    expect(putFiles.mock.calls[0]![0].map((file: { path: string }) => file.path)).toEqual([
      '/mnt/data/data.csv',
      SANDBOX_FILES_INIT_MARKER,
    ]);

    const curlCommands = (provider.callTool as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([tool, params]) =>
        tool === 'runCommand' &&
        typeof params?.command === 'string' &&
        params.command.includes('curl'),
    );
    expect(curlCommands).toHaveLength(0);
    expect(provider.callTool).toHaveBeenCalledWith('listFiles', { directoryPath: '/mnt/data' });
  });

  it('skips an oversize file on the push path and still writes the init marker', async () => {
    findFilesToInitInSandbox.mockResolvedValue([
      { fileType: 'text/csv', id: 'f1', name: 'data.csv', size: 10, url: 'key-1' },
      {
        fileType: 'application/zip',
        id: 'big',
        name: 'huge.zip',
        size: SANDBOX_PUT_FILES_MAX_FILE_BYTES + 1,
        url: 'key-big',
      },
    ]);
    const putFiles = vi.fn(async (files: Array<{ path: string }>) => ({
      failed: [],
      written: files.map((file) => file.path),
    }));
    const provider = createProvider();
    Object.assign(provider, { putFiles });
    const options = baseOptions();
    const service = new SandboxMiddlewareService(provider, options);

    await service.callTool('listFiles', {});

    expect(options.fileService.getFileByteArray).toHaveBeenCalledTimes(1);
    expect(options.fileService.getFileByteArray).toHaveBeenCalledWith('key-1');
    expect(putFiles.mock.calls[0]![0].map((file: { path: string }) => file.path)).toEqual([
      '/mnt/data/data.csv',
      SANDBOX_FILES_INIT_MARKER,
    ]);
  });

  it('falls back to curl when putFiles throws', async () => {
    const putFiles = vi.fn(async () => {
      throw new Error('docker archive failed');
    });
    const provider = createProvider();
    Object.assign(provider, { putFiles });
    const service = new SandboxMiddlewareService(provider, baseOptions());

    await service.callTool('listFiles', {});

    const curlCommands = (provider.callTool as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([tool, params]) =>
        tool === 'runCommand' &&
        typeof params?.command === 'string' &&
        params.command.includes('curl'),
    );
    expect(curlCommands).toHaveLength(1);
  });
});
