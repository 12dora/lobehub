import { sandboxOverLimitUploadPath } from '@lobechat/builtin-tool-cloud-sandbox';
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
import { SANDBOX_ATTACHMENT_SYNC_CONCURRENCY } from '../bootstrap';

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

  it('keeps bot documents that only have a storage key as url', () => {
    const files = selectAttachmentsForSandboxSync(
      [{ fileList: [pdf({ url: 'files/test-user-id/xxx/doc.pdf' })] }],
      { nativeFileInput: false },
    );

    expect(files).toEqual([
      expect.objectContaining({ id: 'file-1', url: 'files/test-user-id/xxx/doc.pdf' }),
    ]);
  });
});

describe('syncSandboxAttachments', () => {
  const downloadFiles = vi.fn();
  const resolveDownloadUrl = vi.fn(async (url: string) => `https://download.example.com/${url}`);

  beforeEach(() => {
    downloadFiles.mockReset();
    resolveDownloadUrl.mockClear();
  });

  it('resolves storage keys and returns collision-free sandbox paths', async () => {
    downloadFiles.mockImplementation(async (files: Array<{ id: string; name: string }>) =>
      Object.fromEntries(
        files.map((file) => [file.id, sandboxOverLimitUploadPath(file.name, file.id)]),
      ),
    );

    const result = await syncSandboxAttachments([pdf()], { downloadFiles, resolveDownloadUrl });

    expect(result.attemptedFileIds).toEqual(['file-1']);
    expect(result.sandboxPathByFileId).toEqual({
      'file-1': sandboxOverLimitUploadPath('report.pdf', 'file-1'),
    });
    expect(downloadFiles).toHaveBeenCalledWith([
      {
        id: 'file-1',
        name: 'report.pdf',
        url: 'https://download.example.com/files/user/report.pdf',
      },
    ]);
    expect(resolveDownloadUrl).toHaveBeenCalledWith('files/user/report.pdf');
  });

  it('de-dupes by file id so the same file is only uploaded once', async () => {
    downloadFiles.mockResolvedValue({
      'file-1': sandboxOverLimitUploadPath('report.pdf', 'file-1'),
    });

    const result = await syncSandboxAttachments(
      [pdf(), pdf({ name: 'report-copy.pdf', url: 'files/user/copy.pdf' })],
      { downloadFiles, resolveDownloadUrl },
    );

    expect(result.attemptedFileIds).toEqual(['file-1']);
    expect(downloadFiles.mock.calls[0][0]).toHaveLength(1);
  });

  it('keeps failed ids in attemptedFileIds without a sandbox path (partial failure)', async () => {
    downloadFiles.mockResolvedValue({
      ok: sandboxOverLimitUploadPath('ok.pdf', 'ok'),
    });

    const result = await syncSandboxAttachments(
      [
        pdf({ id: 'ok', name: 'ok.pdf' }),
        pdf({ id: 'bad', name: 'bad.pdf', url: 'files/user/bad.pdf' }),
      ],
      { downloadFiles, resolveDownloadUrl },
    );

    expect(result.attemptedFileIds).toEqual(['ok', 'bad']);
    expect(result.sandboxPathByFileId).toEqual({
      ok: sandboxOverLimitUploadPath('ok.pdf', 'ok'),
    });
  });

  it('returns all attempted ids and no paths when every download fails', async () => {
    downloadFiles.mockResolvedValue({});

    const result = await syncSandboxAttachments(
      [pdf(), pdf({ id: 'file-2', name: 'other.pdf', url: 'files/user/other.pdf' })],
      { downloadFiles, resolveDownloadUrl },
    );

    expect(result.attemptedFileIds).toEqual(['file-1', 'file-2']);
    expect(result.sandboxPathByFileId).toEqual({});
  });

  it('falls back to text-only when the sandbox download throws', async () => {
    downloadFiles.mockRejectedValue(new Error('sandbox down'));

    await expect(
      syncSandboxAttachments([pdf()], { downloadFiles, resolveDownloadUrl }),
    ).resolves.toEqual({
      attemptedFileIds: ['file-1'],
      sandboxPathByFileId: {},
    });
  });

  it('still records attempted ids when a storage key cannot be signed', async () => {
    resolveDownloadUrl.mockRejectedValueOnce(new Error('no such key'));

    const result = await syncSandboxAttachments([pdf()], { downloadFiles, resolveDownloadUrl });

    expect(result).toEqual({ attemptedFileIds: ['file-1'], sandboxPathByFileId: {} });
    expect(downloadFiles).not.toHaveBeenCalled();
  });

  it('resolves download URLs with bounded concurrency', async () => {
    let current = 0;
    let max = 0;
    resolveDownloadUrl.mockImplementation(async (url: string) => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      current -= 1;
      return `https://download.example.com/${url}`;
    });
    downloadFiles.mockResolvedValue({});

    const files = Array.from({ length: 6 }, (_, index) =>
      pdf({ id: `file-${index}`, url: `files/user/${index}.pdf` }),
    );
    await syncSandboxAttachments(files, { downloadFiles, resolveDownloadUrl });

    expect(max).toBeLessThanOrEqual(SANDBOX_ATTACHMENT_SYNC_CONCURRENCY);
    expect(max).toBeGreaterThan(1);
  });
});

describe('syncOverLimitAttachmentsIfSandboxEnabled', () => {
  const downloadFiles = vi.fn();

  beforeEach(() => {
    downloadFiles.mockReset();
  });

  it('skips the upload when sandbox is not enabled', async () => {
    const result = await syncOverLimitAttachmentsIfSandboxEnabled({
      deps: { downloadFiles },
      enabled: false,
      files: [pdf()],
    });

    expect(result).toEqual({ attemptedFileIds: [], sandboxPathByFileId: {} });
    expect(downloadFiles).not.toHaveBeenCalled();
  });

  it('syncs when sandbox is enabled', async () => {
    downloadFiles.mockResolvedValue({
      'file-1': sandboxOverLimitUploadPath('report.pdf', 'file-1'),
    });

    const result = await syncOverLimitAttachmentsIfSandboxEnabled({
      deps: { downloadFiles },
      enabled: true,
      files: [pdf({ url: 'https://files.example.com/report.pdf' })],
    });

    expect(result.sandboxPathByFileId).toEqual({
      'file-1': sandboxOverLimitUploadPath('report.pdf', 'file-1'),
    });
    expect(downloadFiles).toHaveBeenCalledTimes(1);
  });
});
