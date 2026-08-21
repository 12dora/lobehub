import {
  SANDBOX_OVER_LIMIT_UPLOADS_DIR,
  SANDBOX_UPLOADED_FILES_DIR,
  sandboxOverLimitUploadPath,
} from '@lobechat/builtin-tool-cloud-sandbox';
import { describe, expect, it } from 'vitest';

import {
  buildSandboxAttachmentFileSyncCommand,
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

describe('sandboxOverLimitUploadPath', () => {
  it('allocates distinct destinations for the same filename with different ids', () => {
    expect(sandboxOverLimitUploadPath('report.pdf', 'file-a')).toBe(
      `${SANDBOX_OVER_LIMIT_UPLOADS_DIR}/report-file-a.pdf`,
    );
    expect(sandboxOverLimitUploadPath('report.pdf', 'file-b')).toBe(
      `${SANDBOX_OVER_LIMIT_UPLOADS_DIR}/report-file-b.pdf`,
    );
    expect(sandboxOverLimitUploadPath('report.pdf', 'file-a')).not.toBe(
      sandboxOverLimitUploadPath('report.pdf', 'file-b'),
    );
  });
});

describe('buildSandboxAttachmentFileSyncCommand', () => {
  it('writes a collision-free dest and requires the dest to exist for the marker', () => {
    const command = buildSandboxAttachmentFileSyncCommand({
      id: 'file-1',
      name: 'report.pdf',
      url: 'https://files.example.com/a',
    });
    const dest = sandboxOverLimitUploadPath('report.pdf', 'file-1');

    expect(command).toContain(`mkdir -p '${SANDBOX_OVER_LIMIT_UPLOADS_DIR}'`);
    expect(command).toContain(`-o '${dest}'`);
    expect(command).toContain(
      `if [ -f '${sandboxAttachmentSyncMarker('file-1')}' ] && [ -f '${dest}' ]`,
    );
    expect(command).toContain('--max-time 30');
    expect(command).toContain(`${SANDBOX_ATTACHMENT_SYNC_OK_PREFIX}file-1`);
    expect(command).toContain(`${SANDBOX_ATTACHMENT_SYNC_FAIL_PREFIX}file-1`);
  });

  it('re-downloads when the file is renamed (old marker, new dest)', () => {
    const renamed = buildSandboxAttachmentFileSyncCommand({
      id: 'file-1',
      name: 'renamed.pdf',
      url: 'https://files.example.com/a',
    });
    const newDest = sandboxOverLimitUploadPath('renamed.pdf', 'file-1');
    const oldDest = sandboxOverLimitUploadPath('report.pdf', 'file-1');

    expect(renamed).toContain(newDest);
    expect(renamed).not.toContain(oldDest);
    expect(renamed).toContain(
      `if [ -f '${sandboxAttachmentSyncMarker('file-1')}' ] && [ -f '${newDest}' ]`,
    );
  });

  it('reuses a topic-bootstrap copy at /mnt/data/<name> when present', () => {
    const command = buildSandboxAttachmentFileSyncCommand({
      id: 'file-1',
      name: 'report.pdf',
      url: 'https://files.example.com/a',
    });

    expect(command).toContain(`elif [ -f '${SANDBOX_UPLOADED_FILES_DIR}/report.pdf' ]`);
    expect(command).toContain(
      `cp '${SANDBOX_UPLOADED_FILES_DIR}/report.pdf' '${sandboxOverLimitUploadPath('report.pdf', 'file-1')}'`,
    );
  });
});
