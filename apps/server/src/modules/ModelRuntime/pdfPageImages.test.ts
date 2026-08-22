// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { renderPdfPagesToPng } from './pdfPageImages';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** Minimal 1-page PDF with a filled rectangle (MediaBox 200×100). */
const makeOnePagePdf = (): Uint8Array => {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << >> >>\nendobj\n',
  ];
  const stream = '0.2 0.4 0.8 rg\n10 10 180 80 re\nf\n';
  objects.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);

  const header = '%PDF-1.4\n';
  const offsets = [0];
  let pos = header.length;
  for (const object of objects) {
    offsets.push(pos);
    pos += object.length;
  }

  const xrefLines = ['xref', '0 5', '0000000000 65535 f '];
  for (let index = 1; index <= 4; index += 1) {
    xrefLines.push(`${String(offsets[index]).padStart(10, '0')} 00000 n `);
  }
  const xref = `${xrefLines.join('\n')}\n`;
  const trailer = `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;

  return new TextEncoder().encode(header + objects.join('') + xref + trailer);
};

describe('renderPdfPagesToPng', () => {
  it('renders a one-page PDF to a PNG with plausible dimensions', async () => {
    const pages = await renderPdfPagesToPng(makeOnePagePdf(), {
      maxBytesPerImage: 1024 * 1024,
      maxLongEdgePx: 1800,
      maxPages: 4,
    });

    expect(pages).toHaveLength(1);
    expect(pages[0].kind).toBe('page');
    expect(pages[0].page).toBe(1);
    expect(pages[0].png.subarray(0, 4)).toEqual(new Uint8Array(PNG_MAGIC));
    expect(pages[0].width).toBeGreaterThanOrEqual(50);
    expect(pages[0].height).toBeGreaterThanOrEqual(25);
    expect(pages[0].width).toBeLessThanOrEqual(1800);
    expect(pages[0].height).toBeLessThanOrEqual(1800);
  });

  it('returns a full page plus 2×2 quadrant tiles in reading order', async () => {
    const pages = await renderPdfPagesToPng(makeOnePagePdf(), {
      maxBytesPerImage: 1024 * 1024,
      maxLongEdgePx: 1800,
      maxPages: 4,
      tiles: { grid: 2, maxLongEdgePx: 1800 },
    });

    expect(pages).toHaveLength(5);
    expect(pages[0]).toMatchObject({ kind: 'page', page: 1 });
    expect(pages.slice(1).map((image) => ({ kind: image.kind, tile: image.tile }))).toEqual([
      { kind: 'tile', tile: { col: 0, row: 0 } },
      { kind: 'tile', tile: { col: 1, row: 0 } },
      { kind: 'tile', tile: { col: 0, row: 1 } },
      { kind: 'tile', tile: { col: 1, row: 1 } },
    ]);
    for (const image of pages) {
      expect(image.png.subarray(0, 4)).toEqual(new Uint8Array(PNG_MAGIC));
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(1800);
    }
  });

  it('does not return page or tile images over maxBytesPerImage after retry', async () => {
    const maxBytesPerImage = 32;
    const pages = await renderPdfPagesToPng(makeOnePagePdf(), {
      maxBytesPerImage,
      maxLongEdgePx: 1800,
      maxPages: 4,
      tiles: { grid: 2, maxLongEdgePx: 1800 },
    });

    expect(pages).toEqual([]);
    expect(pages.every((image) => image.png.byteLength <= maxBytesPerImage)).toBe(true);
  });

  it('returns an empty array for invalid bytes instead of throwing', async () => {
    await expect(
      renderPdfPagesToPng(new Uint8Array([1, 2, 3, 4]), {
        maxBytesPerImage: 1024,
        maxLongEdgePx: 1800,
        maxPages: 4,
      }),
    ).resolves.toEqual([]);
  });
});
