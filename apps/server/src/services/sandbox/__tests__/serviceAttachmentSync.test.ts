import { sandboxOverLimitUploadPath } from '@lobechat/builtin-tool-cloud-sandbox';
import { describe, expect, it, vi } from 'vitest';

import type { FileService } from '@/server/services/file';
import type { MarketService } from '@/server/services/market';

import {
  SANDBOX_ATTACHMENT_SYNC_CONCURRENCY,
  SANDBOX_ATTACHMENT_SYNC_FILE_TIMEOUT_MS,
  SANDBOX_ATTACHMENT_SYNC_OK_PREFIX,
  sandboxAttachmentSyncMarker,
} from '../bootstrap';
import { SandboxMiddlewareService } from '../service';
import type { SandboxProvider, SandboxProviderCapabilities } from '../types';
import { SANDBOX_PUT_FILES_MAX_FILE_BYTES, SANDBOX_PUT_FILES_MAX_TOTAL_BYTES } from '../types';

const capabilities: SandboxProviderCapabilities = {
  backgroundCommands: true,
  exportFile: true,
  files: true,
  languages: ['python'],
  persistentSession: true,
  shell: true,
  skillScripts: true,
};

const createProvider = (callTool: SandboxProvider['callTool']): SandboxProvider =>
  ({
    capabilities,
    callTool,
    exportFileToUploadUrl: vi.fn(),
    kind: 'onlyboxes',
  }) satisfies SandboxProvider;

describe('SandboxMiddlewareService.syncOverLimitAttachments', () => {
  it('calls the provider directly (skips topic-file init) with a 30s timeout', async () => {
    const callTool = vi.fn(async () => ({
      result: { stdout: `${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}file-a\n` },
      success: true,
    }));
    const service = new SandboxMiddlewareService(createProvider(callTool), {
      marketService: {} as MarketService,
      topicId: 'topic-1',
      userId: 'user-1',
    });
    const publicCallTool = vi.spyOn(service, 'callTool');

    const result = await service.syncOverLimitAttachments([
      { id: 'file-a', name: 'report.pdf', url: 'https://files.example.com/a' },
    ]);

    expect(publicCallTool).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledWith(
      'runCommand',
      expect.objectContaining({ timeout: SANDBOX_ATTACHMENT_SYNC_FILE_TIMEOUT_MS }),
    );
    expect(result).toEqual({
      'file-a': sandboxOverLimitUploadPath('report.pdf', 'file-a'),
    });
  });

  it('writes distinct destinations for the same filename with different ids', async () => {
    const callTool: SandboxProvider['callTool'] = vi.fn(async (_name, params) => {
      const command = typeof params.command === 'string' ? params.command : '';
      const id = command.includes('file-a') ? 'file-a' : 'file-b';
      return { result: { stdout: `${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}${id}\n` }, success: true };
    });
    const service = new SandboxMiddlewareService(createProvider(callTool), {
      marketService: {} as MarketService,
      topicId: 'topic-1',
      userId: 'user-1',
    });

    const result = await service.syncOverLimitAttachments([
      { id: 'file-a', name: 'report.pdf', url: 'https://files.example.com/a' },
      { id: 'file-b', name: 'report.pdf', url: 'https://files.example.com/b' },
    ]);

    expect(result['file-a']).toBe(sandboxOverLimitUploadPath('report.pdf', 'file-a'));
    expect(result['file-b']).toBe(sandboxOverLimitUploadPath('report.pdf', 'file-b'));
    expect(result['file-a']).not.toBe(result['file-b']);
  });

  it('caps in-flight downloads at 3', async () => {
    let current = 0;
    let max = 0;
    const callTool: SandboxProvider['callTool'] = vi.fn(async (_name, params) => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
      current -= 1;
      const command = typeof params.command === 'string' ? params.command : '';
      const match = command.match(/LOBE_SYNC_OK:([^']+)/);
      const id = match?.[1] ?? 'file-0';
      return { result: { stdout: `${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}${id}\n` }, success: true };
    });
    const service = new SandboxMiddlewareService(createProvider(callTool), {
      marketService: {} as MarketService,
      topicId: 'topic-1',
      userId: 'user-1',
    });

    await service.syncOverLimitAttachments(
      Array.from({ length: 6 }, (_, index) => ({
        id: `file-${index}`,
        name: `f-${index}.pdf`,
        url: `https://files.example.com/${index}`,
      })),
    );

    expect(max).toBeLessThanOrEqual(SANDBOX_ATTACHMENT_SYNC_CONCURRENCY);
    expect(max).toBeGreaterThan(1);
    expect(callTool).toHaveBeenCalledTimes(6);
  });

  it('pushes bytes through putFiles instead of curling, and writes the per-file marker', async () => {
    const callTool = vi.fn(async () => ({ result: { stdout: '' }, success: true }));
    const putFiles = vi.fn(async (files: Array<{ path: string }>) => ({
      failed: [],
      written: files.map((file) => file.path),
    }));
    const getFileByteArray = vi.fn(async () => new Uint8Array([9, 8, 7]));
    const provider = createProvider(callTool);
    Object.assign(provider, { putFiles });
    const service = new SandboxMiddlewareService(provider, {
      fileService: { getFileByteArray } as unknown as FileService,
      marketService: {} as MarketService,
      topicId: 'topic-1',
      userId: 'user-1',
    });

    const result = await service.syncOverLimitAttachments([
      {
        id: 'file-a',
        name: 'report.pdf',
        storageKey: 'files/user/report.pdf',
        url: 'https://files.example.com/a',
      },
    ]);

    expect(getFileByteArray).toHaveBeenCalledWith('files/user/report.pdf');
    expect(putFiles).toHaveBeenCalledTimes(1);
    expect(putFiles.mock.calls[0]![0].map((file: { path: string }) => file.path)).toEqual([
      sandboxOverLimitUploadPath('report.pdf', 'file-a'),
      sandboxAttachmentSyncMarker('file-a'),
    ]);
    expect(result).toEqual({
      'file-a': sandboxOverLimitUploadPath('report.pdf', 'file-a'),
    });

    const curlCommands = (callTool as ReturnType<typeof vi.fn>).mock.calls.filter((call) => {
      const tool = call[0];
      const command = call[1]?.command;
      return tool === 'runCommand' && typeof command === 'string' && command.includes('curl');
    });
    expect(curlCommands).toHaveLength(0);
  });

  it('skips an oversize attachment on the push path and omits it from the result', async () => {
    const callTool = vi.fn(async () => ({ result: { stdout: '' }, success: true }));
    const putFiles = vi.fn(async (files: Array<{ path: string }>) => ({
      failed: [],
      written: files.map((file) => file.path),
    }));
    const getFileByteArray = vi.fn(async (key: string) => {
      if (key === 'files/huge') {
        return { byteLength: SANDBOX_PUT_FILES_MAX_FILE_BYTES + 1 } as Uint8Array;
      }
      return new Uint8Array([1]);
    });
    const provider = createProvider(callTool);
    Object.assign(provider, { putFiles });
    const service = new SandboxMiddlewareService(provider, {
      fileService: { getFileByteArray } as unknown as FileService,
      marketService: {} as MarketService,
      topicId: 'topic-1',
      userId: 'user-1',
    });

    const result = await service.syncOverLimitAttachments([
      { id: 'ok', name: 'ok.pdf', storageKey: 'files/ok', url: 'https://files.example.com/ok' },
      {
        id: 'huge',
        name: 'huge.bin',
        storageKey: 'files/huge',
        url: 'https://files.example.com/huge',
      },
    ]);

    expect(result).toEqual({
      ok: sandboxOverLimitUploadPath('ok.pdf', 'ok'),
    });
    expect(putFiles.mock.calls[0]![0].map((file: { path: string }) => file.path)).toEqual([
      sandboxOverLimitUploadPath('ok.pdf', 'ok'),
      sandboxAttachmentSyncMarker('ok'),
    ]);
  });

  it('skips an oversize attachment before downloading when size is declared', async () => {
    const callTool = vi.fn(async () => ({ result: { stdout: '' }, success: true }));
    const putFiles = vi.fn(async (files: Array<{ path: string }>) => ({
      failed: [],
      written: files.map((file) => file.path),
    }));
    const getFileByteArray = vi.fn(async () => new Uint8Array([1]));
    const provider = createProvider(callTool);
    Object.assign(provider, { putFiles });
    const service = new SandboxMiddlewareService(provider, {
      fileService: { getFileByteArray } as unknown as FileService,
      marketService: {} as MarketService,
      topicId: 'topic-1',
      userId: 'user-1',
    });

    const result = await service.syncOverLimitAttachments([
      {
        id: 'ok',
        name: 'ok.pdf',
        size: 1,
        storageKey: 'files/ok',
        url: 'https://files.example.com/ok',
      },
      {
        id: 'huge',
        name: 'huge.bin',
        size: SANDBOX_PUT_FILES_MAX_FILE_BYTES + 1,
        storageKey: 'files/huge',
        url: 'https://files.example.com/huge',
      },
    ]);

    expect(getFileByteArray).toHaveBeenCalledTimes(1);
    expect(getFileByteArray).toHaveBeenCalledWith('files/ok');
    expect(getFileByteArray).not.toHaveBeenCalledWith('files/huge');
    expect(result).toEqual({
      ok: sandboxOverLimitUploadPath('ok.pdf', 'ok'),
    });
  });

  it('stops fetching over-limit attachments once declared sizes hit the per-call cap', async () => {
    const callTool = vi.fn(async () => ({ result: { stdout: '' }, success: true }));
    const fileSize = SANDBOX_PUT_FILES_MAX_FILE_BYTES;
    const getFileByteArray = vi.fn(async () => ({ byteLength: fileSize }) as Uint8Array);
    const putFiles = vi.fn(async (files: Array<{ path: string }>) => ({
      failed: [],
      written: files.map((file) => file.path),
    }));
    const provider = createProvider(callTool);
    Object.assign(provider, { putFiles });
    const service = new SandboxMiddlewareService(provider, {
      fileService: { getFileByteArray } as unknown as FileService,
      marketService: {} as MarketService,
      topicId: 'topic-1',
      userId: 'user-1',
    });

    await service.syncOverLimitAttachments(
      Array.from({ length: 5 }, (_, index) => ({
        id: `file-${index}`,
        name: `f-${index}.bin`,
        size: fileSize,
        storageKey: `files/${index}`,
        url: `https://files.example.com/${index}`,
      })),
    );

    expect(getFileByteArray).toHaveBeenCalledTimes(4);
    expect(getFileByteArray).not.toHaveBeenCalledWith('files/4');
    expect(SANDBOX_PUT_FILES_MAX_FILE_BYTES * 4).toBe(SANDBOX_PUT_FILES_MAX_TOTAL_BYTES);
  });
});
