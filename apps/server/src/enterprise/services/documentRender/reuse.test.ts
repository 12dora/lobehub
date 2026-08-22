// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { FileRenderMetadata } from '@/types/files';

import { findReusableRenderSource, rebaseRenderMetadataKeys } from './reuse';

const sourceRender = (): FileRenderMetadata => ({
  contactSheets: [{ key: 'files/render/src/contact/0.png', pages: [1, 2] }],
  copiedFrom: 'even-older',
  engine: 'pdfjs',
  figures: [{ key: 'files/render/src/figures/1-1.png', mimeType: 'image/png', page: 1 }],
  pages: {
    '1': {
      chars: 40,
      png: 'files/render/src/pages/1.png',
      thumb: 'files/render/src/thumbs/1.png',
      tiles: ['files/render/src/tiles/1-00.png', 'files/render/src/tiles/1-01.png'],
      visual: true,
    },
  },
  pdf: 'files/render/src/source.pdf',
  status: 'ready',
  textIndex: 'files/render/src/text/index.json',
  tier: 'T2',
});

describe('rebaseRenderMetadataKeys', () => {
  it('rewrites contactSheets, pages, figures, pdf, and textIndex onto the target prefix', () => {
    const rebased = rebaseRenderMetadataKeys(sourceRender(), 'src', 'dst');

    expect(rebased.contactSheets?.[0]?.key).toBe('files/render/dst/contact/0.png');
    expect(rebased.pages?.['1']?.png).toBe('files/render/dst/pages/1.png');
    expect(rebased.pages?.['1']?.thumb).toBe('files/render/dst/thumbs/1.png');
    expect(rebased.pages?.['1']?.tiles).toEqual([
      'files/render/dst/tiles/1-00.png',
      'files/render/dst/tiles/1-01.png',
    ]);
    expect(rebased.figures?.[0]?.key).toBe('files/render/dst/figures/1-1.png');
    expect(rebased.pdf).toBe('files/render/dst/source.pdf');
    expect(rebased.textIndex).toBe('files/render/dst/text/index.json');
    expect(rebased.copiedFrom).toBe('even-older');
    expect(rebased.status).toBe('ready');
  });

  it('leaves keys that are not under the source prefix unchanged', () => {
    const rebased = rebaseRenderMetadataKeys(
      {
        figures: [{ key: 'other/prefix/a.png', mimeType: 'image/png', page: 1 }],
        status: 'ready',
      },
      'src',
      'dst',
    );
    expect(rebased.figures?.[0]?.key).toBe('other/prefix/a.png');
  });
});

describe('findReusableRenderSource', () => {
  it('returns the first matching row that has artifact keys', async () => {
    const row = {
      id: 'src',
      metadata: { render: sourceRender() },
    };
    const limit = vi.fn(async () => [row]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ limit })),
          })),
        })),
      })),
    };

    await expect(
      findReusableRenderSource(db as never, { fileHash: 'abc', fileId: 'dst' }),
    ).resolves.toEqual(row);
    expect(limit).toHaveBeenCalledWith(1);
  });

  it('returns undefined when the row has no artifact keys', async () => {
    const row = {
      id: 'src',
      metadata: { render: { engine: 'pdfjs', status: 'ready' } },
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => [row]),
            })),
          })),
        })),
      })),
    };

    await expect(
      findReusableRenderSource(db as never, { fileHash: 'abc', fileId: 'dst' }),
    ).resolves.toBeUndefined();
  });
});
