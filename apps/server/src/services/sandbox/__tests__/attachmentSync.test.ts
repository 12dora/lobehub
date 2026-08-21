import { SANDBOX_OVER_LIMIT_UPLOADS_DIR } from '@lobechat/builtin-tool-cloud-sandbox';
import type { ChatFileItem } from '@lobechat/types';
import { DEFAULT_FILE_INLINE_MAX_BYTES } from '@lobechat/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isAttachmentNotDeliveredNatively,
  isSandboxAttachmentSyncEnabled,
  selectAttachmentsForSandboxSync,
  syncOverLimitAttachmentsIfSandboxEnabled,
  syncSandboxAttachments,
} from '../attachmentSync';
import {
  SANDBOX_ATTACHMENT_SYNC_FAIL_PREFIX,
  SANDBOX_ATTACHMENT_SYNC_OK_PREFIX,
} from '../bootstrap';

const pdf = (overrides: Partial<ChatFileItem> = {}): ChatFileItem => ({
  fileType: 'application/pdf',
  id: 'file-1',
  name: 'report.pdf',
  size: 1024,
  url: 'files/user/report.pdf',
  ...overrides,
});

describe('isSandboxAttachmentSyncEnabled', () => {
  it('is true only when lobe-cloud-sandbox is enabled for the run', () => {
    expect(isSandboxAttachmentSyncEnabled(['lobe-cloud-sandbox'])).toBe(true);
    expect(isSandboxAttachmentSyncEnabled(['lobe-web-browsing'])).toBe(false);
    expect(isSandboxAttachmentSyncEnabled([])).toBe(false);
  });
});

describe('isAttachmentNotDeliveredNatively', () => {
  it('treats every attachment as non-native when the provider has no file input', () => {
    expect(isAttachmentNotDeliveredNatively(pdf(), false)).toBe(true);
  });

  it('selects documents over the inline limit', () => {
    expect(
      isAttachmentNotDeliveredNatively(pdf({ size: DEFAULT_FILE_INLINE_MAX_BYTES + 1 }), true),
    ).toBe(true);
  });

  it('keeps under-limit documents on the native path', () => {
    expect(isAttachmentNotDeliveredNatively(pdf(), true)).toBe(false);
  });

  it('selects unsupported types even when native file input is available', () => {
    expect(
      isAttachmentNotDeliveredNatively(
        pdf({ fileType: 'application/zip', name: 'archive.zip' }),
        true,
      ),
    ).toBe(true);
  });
});

describe('selectAttachmentsForSandboxSync', () => {
  it('collects every fileList entry when native file input is off', () => {
    const files = selectAttachmentsForSandboxSync(
      [{ fileList: [pdf(), pdf({ id: 'file-2', name: 'notes.txt', fileType: 'text/plain' })] }],
      { nativeFileInput: false },
    );

    expect(files.map((file) => file.id)).toEqual(['file-1', 'file-2']);
  });

  it('only collects over-limit / unsupported files when native file input is on', () => {
    const files = selectAttachmentsForSandboxSync(
      [
        {
          fileList: [
            pdf(),
            pdf({
              id: 'big',
              name: 'huge.pdf',
              size: DEFAULT_FILE_INLINE_MAX_BYTES + 8,
            }),
            pdf({ id: 'zip', name: 'data.zip', fileType: 'application/zip' }),
          ],
        },
      ],
      { nativeFileInput: true },
    );

    expect(files.map((file) => file.id)).toEqual(['big', 'zip']);
  });

  it('de-dupes by file id across messages', () => {
    const files = selectAttachmentsForSandboxSync(
      [{ fileList: [pdf()] }, { fileList: [pdf({ name: 'copy.pdf' })] }],
      { nativeFileInput: false },
    );

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('report.pdf');
  });
});

describe('syncSandboxAttachments', () => {
  const callTool = vi.fn();
  const resolveDownloadUrl = vi.fn(async (url: string) => `https://download.example.com/${url}`);

  beforeEach(() => {
    callTool.mockReset();
    resolveDownloadUrl.mockClear();
  });

  it('uploads into /mnt/data/uploads and returns sandboxPath by file id', async () => {
    callTool.mockResolvedValue({
      result: { stdout: `${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}file-1\n` },
      success: true,
    });

    const result = await syncSandboxAttachments([pdf()], { callTool, resolveDownloadUrl });

    expect(result).toEqual({
      'file-1': `${SANDBOX_OVER_LIMIT_UPLOADS_DIR}/report.pdf`,
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(
      'runCommand',
      expect.objectContaining({
        command: expect.stringContaining(`${SANDBOX_OVER_LIMIT_UPLOADS_DIR}/report.pdf`),
      }),
    );
    expect(resolveDownloadUrl).toHaveBeenCalledWith('files/user/report.pdf');
  });

  it('de-dupes by file id so the same file is only uploaded once', async () => {
    callTool.mockResolvedValue({
      result: { stdout: `${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}file-1\n` },
      success: true,
    });

    const result = await syncSandboxAttachments(
      [pdf(), pdf({ name: 'report-copy.pdf', url: 'files/user/copy.pdf' })],
      { callTool, resolveDownloadUrl },
    );

    expect(Object.keys(result)).toEqual(['file-1']);
    const command = callTool.mock.calls[0][1].command as string;
    const curlCount = command.split('curl ').length - 1;
    expect(curlCount).toBe(1);
  });

  it('omits failed uploads and does not throw', async () => {
    callTool.mockResolvedValue({
      result: {
        stdout: `${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}ok\n${SANDBOX_ATTACHMENT_SYNC_FAIL_PREFIX}bad\n`,
      },
      success: true,
    });

    const result = await syncSandboxAttachments(
      [
        pdf({ id: 'ok', name: 'ok.pdf' }),
        pdf({ id: 'bad', name: 'bad.pdf', url: 'files/user/bad.pdf' }),
      ],
      { callTool, resolveDownloadUrl },
    );

    expect(result).toEqual({ ok: `${SANDBOX_OVER_LIMIT_UPLOADS_DIR}/ok.pdf` });
    expect(result).not.toHaveProperty('bad');
  });

  it('falls back to text-only when the sandbox call throws', async () => {
    callTool.mockRejectedValue(new Error('sandbox down'));

    await expect(
      syncSandboxAttachments([pdf()], { callTool, resolveDownloadUrl }),
    ).resolves.toEqual({});
  });

  it('skips files whose download url cannot be resolved', async () => {
    resolveDownloadUrl.mockRejectedValueOnce(new Error('no such key'));

    const result = await syncSandboxAttachments([pdf()], { callTool, resolveDownloadUrl });

    expect(result).toEqual({});
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('syncOverLimitAttachmentsIfSandboxEnabled', () => {
  const callTool = vi.fn();

  beforeEach(() => {
    callTool.mockReset();
  });

  it('skips the upload when sandbox is not enabled', async () => {
    const result = await syncOverLimitAttachmentsIfSandboxEnabled({
      deps: { callTool },
      enabled: false,
      files: [pdf()],
    });

    expect(result).toEqual({});
    expect(callTool).not.toHaveBeenCalled();
  });

  it('syncs when sandbox is enabled', async () => {
    callTool.mockResolvedValue({
      result: { stdout: `${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}file-1\n` },
      success: true,
    });

    const result = await syncOverLimitAttachmentsIfSandboxEnabled({
      deps: { callTool },
      enabled: true,
      files: [pdf({ url: 'https://files.example.com/report.pdf' })],
    });

    expect(result).toEqual({
      'file-1': `${SANDBOX_OVER_LIMIT_UPLOADS_DIR}/report.pdf`,
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
