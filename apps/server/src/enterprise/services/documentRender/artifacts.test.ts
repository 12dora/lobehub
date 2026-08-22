// @vitest-environment node
import { createCanvas } from '@napi-rs/canvas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { composeContactSheet, copyDocumentRenderArtifacts, uploadJsonArtifact } from './artifacts';

const s3Mocks = vi.hoisted(() => ({
  copyObject: vi.fn(),
  deleteFiles: vi.fn(),
  listObjectKeysByPrefix: vi.fn(),
  uploadBuffer: vi.fn(),
}));

vi.mock('@/server/modules/S3', () => ({
  createFileS3: vi.fn(async () => s3Mocks),
}));

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const makePng = (width: number, height: number, fill: string): Uint8Array => {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, width, height);
  return Uint8Array.from(canvas.toBuffer('image/png'));
};

describe('composeContactSheet', () => {
  it('lays out thumbs on a white grid with gutter and returns expected pixel size', async () => {
    const thumbs = [
      { page: 1, png: makePng(10, 10, '#ff0000') },
      { page: 2, png: makePng(10, 10, '#00ff00') },
      { page: 3, png: makePng(10, 10, '#0000ff') },
      { page: 4, png: makePng(10, 10, '#ffff00') },
    ];
    const sheet = await composeContactSheet({ cols: 2, rows: 2, thumbs });
    expect(sheet).toBeDefined();
    // 2 cells of 10px + 3 gutters of 8px = 44
    expect(sheet!.width).toBe(2 * 10 + 3 * 8);
    expect(sheet!.height).toBe(2 * 10 + 3 * 8);
    expect(sheet!.pages).toEqual([1, 2, 3, 4]);
    expect([...sheet!.png.subarray(0, 4)]).toEqual(PNG_MAGIC);
  });

  it('returns undefined when there are no thumbs', async () => {
    await expect(composeContactSheet({ cols: 3, rows: 4, thumbs: [] })).resolves.toBeUndefined();
  });
});

describe('uploadJsonArtifact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads JSON with application/json', async () => {
    await uploadJsonArtifact('files/render/f1/text/index.json', { '1': 'hello' });
    expect(s3Mocks.uploadBuffer).toHaveBeenCalledWith(
      'files/render/f1/text/index.json',
      expect.any(Buffer),
      'application/json',
    );
    const body = s3Mocks.uploadBuffer.mock.calls[0]![1] as Buffer;
    expect(JSON.parse(body.toString())).toEqual({ '1': 'hello' });
  });
});

describe('copyDocumentRenderArtifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3Mocks.copyObject.mockResolvedValue(undefined);
    s3Mocks.deleteFiles.mockResolvedValue(undefined);
  });

  it('copies each listed key onto the target prefix and verifies the count', async () => {
    const sourceKeys = [
      'files/render/src/pages/1.png',
      'files/render/src/contact/0.png',
      'files/render/src/text/index.json',
    ];
    const targetKeys = [
      'files/render/dst/pages/1.png',
      'files/render/dst/contact/0.png',
      'files/render/dst/text/index.json',
    ];
    s3Mocks.listObjectKeysByPrefix
      .mockResolvedValueOnce(sourceKeys)
      .mockResolvedValueOnce(targetKeys);

    await expect(copyDocumentRenderArtifacts('src', 'dst')).resolves.toBe(3);
    expect(s3Mocks.copyObject).toHaveBeenCalledTimes(3);
    expect(s3Mocks.copyObject).toHaveBeenCalledWith(
      'files/render/src/pages/1.png',
      'files/render/dst/pages/1.png',
    );
    expect(s3Mocks.deleteFiles).not.toHaveBeenCalled();
  });

  it('deletes the target prefix and throws when the copied count mismatches', async () => {
    s3Mocks.listObjectKeysByPrefix
      .mockResolvedValueOnce(['files/render/src/pages/1.png', 'files/render/src/pages/2.png'])
      .mockResolvedValueOnce(['files/render/dst/pages/1.png'])
      .mockResolvedValueOnce(['files/render/dst/pages/1.png']);

    await expect(copyDocumentRenderArtifacts('src', 'dst')).rejects.toThrow('count mismatch');
    expect(s3Mocks.deleteFiles).toHaveBeenCalledWith(['files/render/dst/pages/1.png']);
  });
});
