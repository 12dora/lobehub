import {
  SANDBOX_OVER_LIMIT_UPLOADS_DIR,
  SANDBOX_UPLOADED_FILES_DIR,
} from '@lobechat/builtin-tool-cloud-sandbox';
import { describe, expect, it } from 'vitest';

import {
  buildSandboxAttachmentUploadCommand,
  buildSandboxFilesInitCommand,
  SANDBOX_ATTACHMENT_SYNC_FAIL_PREFIX,
  SANDBOX_ATTACHMENT_SYNC_OK_PREFIX,
  SANDBOX_FILES_INIT_MARKER,
  sandboxAttachmentSyncMarker,
} from '../bootstrap';

describe('buildSandboxFilesInitCommand', () => {
  it('only ensures the dir when there is nothing to download', () => {
    expect(buildSandboxFilesInitCommand([])).toBe(`mkdir -p '${SANDBOX_UPLOADED_FILES_DIR}'`);
  });

  it('wraps downloads in an idempotent marker guard', () => {
    const command = buildSandboxFilesInitCommand([
      { name: 'data.csv', url: 'https://files.example.com/a' },
    ]);

    expect(command).toContain(`if [ ! -f '${SANDBOX_FILES_INIT_MARKER}' ]; then`);
    expect(command).toContain(
      `curl -fsSL 'https://files.example.com/a' -o '${SANDBOX_UPLOADED_FILES_DIR}/data.csv' || true`,
    );
    expect(command).toContain(`touch '${SANDBOX_FILES_INIT_MARKER}'`);
  });

  it('de-dupes downloads that resolve to the same sandbox path', () => {
    const command = buildSandboxFilesInitCommand([
      { name: 'a/data.csv', url: 'https://files.example.com/a' },
      { name: 'b/data.csv', url: 'https://files.example.com/b' },
    ]);

    const curlCount = command.split('curl ').length - 1;
    expect(curlCount).toBe(1);
  });

  it('skips entries without a download url', () => {
    const command = buildSandboxFilesInitCommand([{ name: 'data.csv', url: '' }]);
    expect(command).toBe(`mkdir -p '${SANDBOX_UPLOADED_FILES_DIR}'`);
  });

  it('escapes single quotes in names and urls', () => {
    const command = buildSandboxFilesInitCommand([{ name: "o'brien.txt", url: "https://x/a'b" }]);

    expect(command).toContain(String.raw`o'\''brien.txt`);
    expect(command).toContain(String.raw`'https://x/a'\''b'`);
  });
});

describe('buildSandboxAttachmentUploadCommand', () => {
  it('only ensures the uploads dir when there is nothing to download', () => {
    expect(buildSandboxAttachmentUploadCommand([])).toBe(
      `mkdir -p '${SANDBOX_OVER_LIMIT_UPLOADS_DIR}'`,
    );
  });

  it('downloads into /mnt/data/uploads with a per-file-id marker', () => {
    const command = buildSandboxAttachmentUploadCommand([
      { id: 'file-1', name: 'report.pdf', url: 'https://files.example.com/a' },
    ]);

    expect(command).toContain(`mkdir -p '${SANDBOX_OVER_LIMIT_UPLOADS_DIR}'`);
    expect(command).toContain(
      `curl -fsSL 'https://files.example.com/a' -o '${SANDBOX_OVER_LIMIT_UPLOADS_DIR}/report.pdf'`,
    );
    expect(command).toContain(`if [ -f '${sandboxAttachmentSyncMarker('file-1')}' ]`);
    expect(command).toContain(`${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}file-1`);
    expect(command).toContain(`${SANDBOX_ATTACHMENT_SYNC_FAIL_PREFIX}file-1`);
  });

  it('de-dupes downloads by file id', () => {
    const command = buildSandboxAttachmentUploadCommand([
      { id: 'file-1', name: 'a.pdf', url: 'https://files.example.com/a' },
      { id: 'file-1', name: 'b.pdf', url: 'https://files.example.com/b' },
    ]);

    const curlCount = command.split('curl ').length - 1;
    expect(curlCount).toBe(1);
    expect(command).toContain('a.pdf');
    expect(command).not.toContain('b.pdf');
  });
});
