import { sandboxOverLimitUploadPath } from '@lobechat/builtin-tool-cloud-sandbox';
import { describe, expect, it, vi } from 'vitest';

import type { MarketService } from '@/server/services/market';

import {
  SANDBOX_ATTACHMENT_SYNC_CONCURRENCY,
  SANDBOX_ATTACHMENT_SYNC_FILE_TIMEOUT_MS,
  SANDBOX_ATTACHMENT_SYNC_OK_PREFIX,
} from '../bootstrap';
import { SandboxMiddlewareService } from '../service';
import type { SandboxProvider, SandboxProviderCapabilities } from '../types';

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
});
