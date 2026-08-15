import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeExecutorContext } from '../context';

const { addFiles, deleteUserFileRecord, fileServiceArgs, publishStreamChunk, uploadFromBuffer } =
  vi.hoisted(() => ({
    addFiles: vi.fn(async () => ({ success: true })),
    deleteUserFileRecord: vi.fn(async () => undefined),
    fileServiceArgs: [] as unknown[][],
    publishStreamChunk: vi.fn(async () => 'event-1'),
    uploadFromBuffer: vi.fn(async () => ({
      fileId: 'file-1',
      key: 'key-1',
      url: 'https://app.example.com/f/file-1',
    })),
  }));

vi.mock('@/server/services/file', () => ({
  FileService: class {
    constructor(
      public db: unknown,
      public userId: string,
      public workspaceId?: string,
    ) {
      fileServiceArgs.push([db, userId, workspaceId]);
    }
    deleteUserFileRecord = deleteUserFileRecord;
    uploadFromBuffer = uploadFromBuffer;
  },
}));

const {
  MAX_GENERATED_FILE_BYTES,
  createGeneratedFileDedupeStore,
  createGeneratedFileUploader,
  decodedBase64Length,
  parseBase64DataUri,
  sanitizeGeneratedFileName,
} = await import('./serverCallLlmGeneratedFile');

const dataUri = (mime: string, content: string) =>
  `data:${mime};base64,${Buffer.from(content).toString('base64')}`;

const createCtx = (overrides: Partial<RuntimeExecutorContext> = {}) =>
  ({
    messageModel: { addFiles },
    operationId: 'op-1',
    serverDB: {},
    stepIndex: 2,
    streamManager: { publishStreamChunk },
    userId: 'user-1',
    workspaceId: 'ws-1',
    ...overrides,
  }) as unknown as RuntimeExecutorContext;

const createUploader = (
  ctx = createCtx(),
  dedupe?: ReturnType<typeof createGeneratedFileDedupeStore>,
) =>
  createGeneratedFileUploader({
    assistantMessageId: 'assistant-msg-1',
    ctx,
    dedupe,
    operationLogId: 'op-1:2',
  });

describe('sanitizeGeneratedFileName', () => {
  it('strips directories, control chars and reserved characters', () => {
    expect(sanitizeGeneratedFileName('/mnt/data/report.pdf')).toBe('report.pdf');
    expect(sanitizeGeneratedFileName('..\\..\\evil.docx')).toBe('evil.docx');
    expect(sanitizeGeneratedFileName('a\u0000b:c.txt')).toBe('ab_c.txt');
  });

  it('falls back to a generated name and keeps the extension when truncating', () => {
    expect(sanitizeGeneratedFileName(undefined)).toMatch(/^generated-file-/);
    expect(sanitizeGeneratedFileName('...')).toMatch(/^generated-file-/);

    const long = sanitizeGeneratedFileName(`${'a'.repeat(300)}.pdf`);
    expect(long.length).toBe(128);
    expect(long.endsWith('.pdf')).toBe(true);
  });
});

describe('parseBase64DataUri', () => {
  it('parses a base64 data URI', () => {
    expect(parseBase64DataUri(dataUri('application/pdf', 'hello'))).toEqual({
      base64: Buffer.from('hello').toString('base64'),
      mimeType: 'application/pdf',
    });
  });

  it('rejects non-base64 payloads', () => {
    expect(parseBase64DataUri('data:text/plain,hello')).toBeUndefined();
    expect(parseBase64DataUri('https://example.com/a.pdf')).toBeUndefined();
    expect(parseBase64DataUri('data:application/pdf;base64,')).toBeUndefined();
  });
});

describe('decodedBase64Length', () => {
  it('accounts for padding', () => {
    expect(decodedBase64Length(Buffer.from('a').toString('base64'))).toBe(1); // 'YQ=='
    expect(decodedBase64Length(Buffer.from('ab').toString('base64'))).toBe(2); // 'YWI='
    expect(decodedBase64Length(Buffer.from('abc').toString('base64'))).toBe(3); // 'YWJj'
  });

  it('admits a file of exactly the cap and rejects the next byte', () => {
    // 32 MiB encodes to 44,739,244 chars with one '=' of padding; the
    // padding-blind `length * 3 / 4` reported 33,554,433 and rejected it.
    const atCap = `${'A'.repeat(44_739_243)}=`;
    expect(decodedBase64Length(atCap)).toBe(MAX_GENERATED_FILE_BYTES);
    // 32 MiB + 1 byte is 33,554,433 = 3 * 11,184,811 bytes → unpadded
    expect(decodedBase64Length('A'.repeat(44_739_244))).toBe(MAX_GENERATED_FILE_BYTES + 1);
  });
});

describe('createGeneratedFileUploader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileServiceArgs.length = 0;
    uploadFromBuffer.mockResolvedValue({
      fileId: 'file-1',
      key: 'key-1',
      url: 'https://app.example.com/f/file-1',
    });
    addFiles.mockResolvedValue({ success: true });
    deleteUserFileRecord.mockResolvedValue(undefined);
  });

  it('uploads, attaches to the streaming assistant message and publishes metadata only', async () => {
    const uploader = createUploader();

    uploader.handleFile({
      data: dataUri('application/pdf', 'pdf-bytes'),
      mimeType: 'application/pdf',
      name: '/mnt/data/report.pdf',
      size: 9,
      sourcePath: 'sandbox:/mnt/data/report.pdf',
    });
    await uploader.waitForUploads();

    expect(uploadFromBuffer).toHaveBeenCalledTimes(1);
    const [buffer, mimeType, pathname] = uploadFromBuffer.mock.calls[0] as unknown as [
      Buffer,
      string,
      string,
    ];
    expect(buffer.toString()).toBe('pdf-bytes');
    expect(mimeType).toBe('application/pdf');
    // <prefix>/generations/<YYYY-MM-DD>/<nanoid>/<sanitized-name>; the sanitized
    // name is the last segment so the stored record keeps it
    expect(pathname).toMatch(/^.+\/generations\/\d{4}-\d{2}-\d{2}\/[^/]+\/report\.pdf$/);
    // the run owner's storage, scoped to the operation's workspace
    expect(fileServiceArgs[0]).toEqual([expect.anything(), 'user-1', 'ws-1']);

    expect(addFiles).toHaveBeenCalledWith('assistant-msg-1', ['file-1']);

    expect(publishStreamChunk).toHaveBeenCalledWith('op-1', 2, {
      chunkType: 'file',
      file: {
        fileType: 'application/pdf',
        id: 'file-1',
        name: 'report.pdf',
        size: 9,
        url: 'https://app.example.com/f/file-1',
      },
    });
    // the base64 payload never leaves the server
    expect(JSON.stringify(publishStreamChunk.mock.calls[0])).not.toContain('base64');
  });

  it('drops a file larger than the cap without uploading', async () => {
    const uploader = createUploader();

    uploader.handleFile({
      // 4 base64 chars carry 3 bytes, so this decodes to just past the cap
      data: `data:application/zip;base64,${'A'.repeat(
        Math.ceil(((MAX_GENERATED_FILE_BYTES + 1024) * 4) / 3),
      )}`,
      mimeType: 'application/zip',
      name: 'huge.zip',
      size: MAX_GENERATED_FILE_BYTES + 1,
    });
    await uploader.waitForUploads();

    expect(uploadFromBuffer).not.toHaveBeenCalled();
    expect(addFiles).not.toHaveBeenCalled();
    expect(publishStreamChunk).not.toHaveBeenCalled();
  });

  it('drops a chunk that carries no base64 data URI', async () => {
    const uploader = createUploader();

    uploader.handleFile({
      data: 'https://example.com/report.pdf',
      mimeType: 'application/pdf',
      name: 'report.pdf',
      size: 10,
    });
    await uploader.waitForUploads();

    expect(uploadFromBuffer).not.toHaveBeenCalled();
    expect(publishStreamChunk).not.toHaveBeenCalled();
  });

  it('tolerates an upload failure without rejecting or publishing', async () => {
    uploadFromBuffer.mockRejectedValueOnce(new Error('s3 down'));
    const uploader = createUploader();

    uploader.handleFile({
      data: dataUri('application/pdf', 'pdf-bytes'),
      mimeType: 'application/pdf',
      name: 'report.pdf',
      size: 9,
    });

    await expect(uploader.waitForUploads()).resolves.toBeUndefined();
    expect(addFiles).not.toHaveBeenCalled();
    expect(publishStreamChunk).not.toHaveBeenCalled();
  });

  it('does not publish when addFiles resolves success=false, and drops the orphan record', async () => {
    // A `file` chunk asserts the file is already attached; publishing an
    // unattached one paints a card that vanishes on the next DB reconciliation.
    addFiles.mockResolvedValueOnce({ success: false } as any);
    const uploader = createUploader();

    uploader.handleFile({
      data: dataUri('text/csv', 'a,b'),
      mimeType: 'text/csv',
      name: 'out.csv',
      size: 3,
    });

    await expect(uploader.waitForUploads()).resolves.toBeUndefined();
    expect(publishStreamChunk).not.toHaveBeenCalled();
    // only the user file row goes — the content-addressed globalFiles/S3 object
    // may be shared with another file
    expect(deleteUserFileRecord).toHaveBeenCalledWith('file-1');
    expect(uploader.attachedFileCount()).toBe(0);
  });

  it('does not publish when the messages_files attach throws', async () => {
    addFiles.mockRejectedValueOnce(new Error('db down'));
    const uploader = createUploader();

    uploader.handleFile({
      data: dataUri('text/csv', 'a,b'),
      mimeType: 'text/csv',
      name: 'out.csv',
      size: 3,
    });

    await expect(uploader.waitForUploads()).resolves.toBeUndefined();
    expect(publishStreamChunk).not.toHaveBeenCalled();
    expect(deleteUserFileRecord).toHaveBeenCalledWith('file-1');
  });

  it('counts attached files so a file-only turn is not an empty completion', async () => {
    const uploader = createUploader();

    uploader.handleFile({
      data: dataUri('application/pdf', 'pdf-bytes'),
      mimeType: 'application/pdf',
      name: 'report.pdf',
      size: 9,
    });
    await uploader.waitForUploads();

    expect(uploader.attachedFileCount()).toBe(1);
  });

  it('attaches the same export once across retry attempts sharing a dedupe store', async () => {
    const dedupe = createGeneratedFileDedupeStore();
    const file = {
      data: dataUri('application/pdf', 'pdf-bytes'),
      mimeType: 'application/pdf',
      name: 'report.pdf',
      size: 9,
    };

    const firstAttempt = createUploader(createCtx(), dedupe);
    firstAttempt.handleFile(file);
    await firstAttempt.waitForUploads();

    // the retried attempt regenerates the identical export
    const secondAttempt = createUploader(createCtx(), dedupe);
    secondAttempt.handleFile(file);
    await secondAttempt.waitForUploads();

    expect(uploadFromBuffer).toHaveBeenCalledTimes(1);
    expect(addFiles).toHaveBeenCalledTimes(1);
    expect(publishStreamChunk).toHaveBeenCalledTimes(1);
    expect(secondAttempt.attachedFileCount()).toBe(0);
  });

  it('lets a retry re-upload a file whose first upload failed', async () => {
    const dedupe = createGeneratedFileDedupeStore();
    const file = {
      data: dataUri('application/pdf', 'pdf-bytes'),
      mimeType: 'application/pdf',
      name: 'report.pdf',
      size: 9,
    };

    uploadFromBuffer.mockRejectedValueOnce(new Error('s3 down'));
    const firstAttempt = createUploader(createCtx(), dedupe);
    firstAttempt.handleFile(file);
    await firstAttempt.waitForUploads();

    const secondAttempt = createUploader(createCtx(), dedupe);
    secondAttempt.handleFile(file);
    await secondAttempt.waitForUploads();

    expect(uploadFromBuffer).toHaveBeenCalledTimes(2);
    expect(addFiles).toHaveBeenCalledTimes(1);
  });

  it('cancel() suppresses attach and publish for an upload still in flight', async () => {
    let releaseUpload: (value: { fileId: string; key: string; url: string }) => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    uploadFromBuffer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUpload = resolve as typeof releaseUpload;
          markStarted();
        }),
    );

    const uploader = createUploader();
    uploader.handleFile({
      data: dataUri('application/pdf', 'pdf-bytes'),
      mimeType: 'application/pdf',
      name: 'report.pdf',
      size: 9,
    });
    await started;

    const cancelled = uploader.cancel();
    releaseUpload({ fileId: 'file-1', key: 'key-1', url: 'https://app.example.com/f/file-1' });
    await expect(cancelled).resolves.toBeUndefined();

    expect(addFiles).not.toHaveBeenCalled();
    expect(publishStreamChunk).not.toHaveBeenCalled();
    expect(deleteUserFileRecord).toHaveBeenCalledWith('file-1');
  });

  it('ignores files handed over after cancel()', async () => {
    const uploader = createUploader();
    await uploader.cancel();

    uploader.handleFile({
      data: dataUri('application/pdf', 'pdf-bytes'),
      mimeType: 'application/pdf',
      name: 'report.pdf',
      size: 9,
    });
    await uploader.waitForUploads();

    expect(uploadFromBuffer).not.toHaveBeenCalled();
  });

  it('tolerates a publish failure', async () => {
    publishStreamChunk.mockRejectedValueOnce(new Error('redis down'));
    const uploader = createUploader();

    uploader.handleFile({
      data: dataUri('text/csv', 'a,b'),
      mimeType: 'text/csv',
      name: 'out.csv',
      size: 3,
    });

    await expect(uploader.waitForUploads()).resolves.toBeUndefined();
    expect(addFiles).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a run owner', async () => {
    const uploader = createUploader(createCtx({ userId: undefined }));

    uploader.handleFile({
      data: dataUri('application/pdf', 'pdf-bytes'),
      mimeType: 'application/pdf',
      name: 'report.pdf',
      size: 9,
    });
    await uploader.waitForUploads();

    expect(uploadFromBuffer).not.toHaveBeenCalled();
  });

  it('waits for every in-flight upload', async () => {
    const uploader = createUploader();

    uploader.handleFile({
      data: dataUri('application/pdf', 'one'),
      mimeType: 'application/pdf',
      name: 'one.pdf',
      size: 3,
    });
    uploader.handleFile({
      data: dataUri('application/pdf', 'two'),
      mimeType: 'application/pdf',
      name: 'two.pdf',
      size: 3,
    });
    await uploader.waitForUploads();

    expect(uploadFromBuffer).toHaveBeenCalledTimes(2);
    expect(publishStreamChunk).toHaveBeenCalledTimes(2);
  });
});
