// @vitest-environment node
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import { composeContactSheet } from './artifacts';

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
