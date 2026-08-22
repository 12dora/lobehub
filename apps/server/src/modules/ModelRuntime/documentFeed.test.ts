// @vitest-environment node
import type { FileRenderMetadata } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import {
  collectAttachedDocumentFiles,
  parseMentionedPages,
  rankPagesByRelevance,
  selectDocumentFeed,
} from './documentFeed';

const readyRender = (overrides: Partial<FileRenderMetadata> = {}): FileRenderMetadata => ({
  contactSheets: [
    { key: 'files/render/f1/contact/0.png', pages: [1, 2, 3] },
    { key: 'files/render/f1/contact/1.png', pages: [4, 5, 6] },
  ],
  hasTextLayer: true,
  pageCount: 6,
  pages: {
    '1': { chars: 40, png: 'files/render/f1/pages/1.png', visual: true },
    '2': { chars: 10, png: 'files/render/f1/pages/2.png', visual: true },
    '3': {
      chars: 8,
      png: 'files/render/f1/pages/3.png',
      tiles: [
        'files/render/f1/tiles/3-00.png',
        'files/render/f1/tiles/3-01.png',
        'files/render/f1/tiles/3-10.png',
        'files/render/f1/tiles/3-11.png',
      ],
      visual: true,
    },
    '4': { chars: 20, png: 'files/render/f1/pages/4.png', visual: true },
    '5': { chars: 12, png: 'files/render/f1/pages/5.png', visual: true },
    '6': { chars: 30, png: 'files/render/f1/pages/6.png', visual: true },
  },
  renderedPages: [1, 2, 3, 4, 5, 6],
  status: 'ready',
  tier: 'T2',
  ...overrides,
});

describe('parseMentionedPages', () => {
  it('parses page 3, 第3页, p.3, slides 2-4, and 幻灯片 2', () => {
    expect(parseMentionedPages('see page 3 please')).toEqual([3]);
    expect(parseMentionedPages('看第3页')).toEqual([3]);
    expect(parseMentionedPages('p.3')).toEqual([3]);
    expect(parseMentionedPages('slides 2-4')).toEqual([2, 3, 4]);
    expect(parseMentionedPages('幻灯片 2')).toEqual([2]);
  });
});

describe('collectAttachedDocumentFiles', () => {
  it('collects file_url ids and files_info tags', () => {
    const files = collectAttachedDocumentFiles({
      content: [
        {
          text: '<files_info><file id="info-1" name="deck.pptx" type="application/vnd.openxmlformats-officedocument.presentationml.presentation"></file></files_info>',
          type: 'text',
        },
        {
          file_url: {
            fileId: 'url-1',
            mimeType: 'application/pdf',
            name: 'report.pdf',
            url: 'http://localhost:3010/f/url-1',
          },
          type: 'file_url',
        },
      ],
      role: 'user',
    });
    expect(files).toEqual([
      {
        fileId: 'info-1',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        name: 'deck.pptx',
      },
      { fileId: 'url-1', mimeType: 'application/pdf', name: 'report.pdf' },
    ]);
  });
});

describe('selectDocumentFeed', () => {
  it('attaches contact sheets then mentioned pages, and lists unattached visual pages', async () => {
    const result = await selectDocumentFeed({
      files: [{ fileId: 'f1', name: 'deck.pptx' }],
      imageMaxCount: 3,
      loadRender: async () => readyRender(),
      tools: true,
      userText: 'What is on page 3?',
    });

    expect(result.fedFileIds).toEqual(['f1']);
    expect(result.images.map((image) => image.kind)).toEqual([
      'contactSheet',
      'contactSheet',
      'page',
    ]);
    expect(result.images.at(-1)).toMatchObject({ detail: 'high', kind: 'page', page: 3 });
    expect(result.notices[0]).toContain('Document "deck.pptx": 6 pages, text layer: yes');
    expect(result.notices[0]).toContain('2 contact sheets');
    expect(result.notices[0]).toContain('full page 3');
    expect(result.notices[0]).toContain('call viewDocumentPages or name the page numbers');
    expect(result.notices[0]).toContain('[pages 1…2, 4…6 contain images, not attached]');
  });

  it('attaches tiles when a single page is selected and budget remains', async () => {
    const result = await selectDocumentFeed({
      files: [{ fileId: 'f1', name: 'deck.pptx' }],
      imageMaxCount: 8,
      loadRender: async () => readyRender(),
      userText: 'page 3',
    });

    expect(result.images.filter((image) => image.kind === 'tile')).toHaveLength(4);
  });

  it('falls back to visual pages then does not mention the tool on Cursor', async () => {
    const result = await selectDocumentFeed({
      files: [{ fileId: 'f1', name: 'deck.pptx' }],
      imageMaxCount: 4,
      loadRender: async () => readyRender(),
      tools: false,
      userText: 'summarize this deck',
    });

    expect(
      result.images.filter((image) => image.kind === 'page').map((image) => image.page),
    ).toEqual([1, 2]);
    expect(result.notices[0]).toContain('name the page numbers in your next message');
    expect(result.notices[0]).not.toContain('viewDocumentPages');
  });

  it('emits a pending notice with no images', async () => {
    const result = await selectDocumentFeed({
      files: [{ fileId: 'f1', name: 'deck.pptx' }],
      loadRender: async () => ({ status: 'pending', tier: 'T2' }),
      userText: 'hello',
    });

    expect(result.images).toEqual([]);
    expect(result.fedFileIds).toEqual([]);
    expect(result.notices).toEqual([
      '[Document "deck.pptx" page images are still being prepared; text only this turn]',
    ]);
  });

  it('does not mark a pending PDF as fed and emits no preparing notice', async () => {
    const result = await selectDocumentFeed({
      files: [{ fileId: 'f1', mimeType: 'application/pdf', name: 'scan.pdf' }],
      loadRender: async () => ({ status: 'pending', tier: 'T2' }),
      userText: 'hello',
    });

    expect(result).toEqual({ fedFileIds: [], images: [], notices: [] });
  });

  it('skips T0 and skipped renders with no notice', async () => {
    const result = await selectDocumentFeed({
      files: [
        { fileId: 't0', name: 'notes.docx' },
        { fileId: 'skip', name: 'huge.pptx' },
      ],
      loadRender: async (fileId) =>
        fileId === 't0' ? { status: 'skipped', tier: 'T0' } : { status: 'skipped', tier: 'T2' },
      userText: 'read these',
    });

    expect(result).toEqual({ fedFileIds: [], images: [], notices: [] });
  });

  it('caps documents per request', async () => {
    const result = await selectDocumentFeed({
      files: [
        { fileId: 'a', name: 'a.pptx' },
        { fileId: 'b', name: 'b.pptx' },
        { fileId: 'c', name: 'c.pptx' },
      ],
      maxDocsPerRequest: 2,
      loadRender: async () => ({ status: 'pending', tier: 'T2' }),
      userText: 'all of them',
    });

    expect(result.fedFileIds).toEqual([]);
    expect(result.notices).toHaveLength(2);
  });

  it('ranks pages by relevance when the user did not mention a page', async () => {
    const loadTextIndex = vi.fn(async () => ({
      '1': 'cover letter and agenda',
      '2': 'quarterly revenue grew across regions',
      '3': 'appendix tables',
      '4': 'revenue forecast and revenue outlook',
    }));
    const result = await selectDocumentFeed({
      files: [
        {
          fileId: 'f1',
          name: 'deck.pptx',
        },
      ],
      imageMaxCount: 3,
      loadRender: async () =>
        readyRender({
          textIndex: 'files/render/f1/text/index.json',
        }),
      loadTextIndex,
      userText: 'What is the quarterly revenue?',
    });

    expect(loadTextIndex).toHaveBeenCalledWith('f1', 'files/render/f1/text/index.json');
    expect(
      result.images.filter((image) => image.kind === 'page').map((image) => image.page),
    ).toEqual([2]);
    expect(result.notices[0]).toContain('full page 2 (matched your question)');
  });

  it('does not load the text index when the user mentioned a page', async () => {
    const loadTextIndex = vi.fn();
    await selectDocumentFeed({
      files: [{ fileId: 'f1', name: 'deck.pptx' }],
      imageMaxCount: 3,
      loadRender: async () => readyRender({ textIndex: 'files/render/f1/text/index.json' }),
      loadTextIndex,
      userText: 'What is on page 3?',
    });
    expect(loadTextIndex).not.toHaveBeenCalled();
  });
});

describe('rankPagesByRelevance', () => {
  it('ranks English pages by distinct tokens then extra occurrences, ties by page number', () => {
    const index = {
      '1': 'quarterly revenue grew',
      '2': 'appendix',
      '3': 'revenue revenue revenue',
    };
    expect(rankPagesByRelevance(index, 'quarterly revenue figures', [1, 2, 3])).toEqual([1, 3]);
  });

  it('ranks Chinese pages by CJK bigrams', () => {
    const index = {
      '1': '市场分析报告',
      '2': '附录内容',
      '3': '市场分析与展望',
    };
    expect(rankPagesByRelevance(index, '市场分析', [1, 2, 3])).toEqual([1, 3]);
  });

  it('returns the lower page first when scores tie', () => {
    const index = {
      '2': 'alpha beta',
      '5': 'alpha beta',
      '9': 'unrelated',
    };
    expect(rankPagesByRelevance(index, 'alpha beta gamma', [9, 5, 2])).toEqual([2, 5]);
  });

  it('returns empty when the query has fewer than two tokens', () => {
    const index = { '1': 'hello world there' };
    expect(rankPagesByRelevance(index, 'hi', [1])).toEqual([]);
    expect(rankPagesByRelevance(index, '', [1])).toEqual([]);
  });

  it('ranks when a single query token is at least 4 characters', () => {
    const index = { '1': 'hello world there', '2': 'other' };
    expect(rankPagesByRelevance(index, 'hello', [1, 2])).toEqual([1]);
  });

  it('ranks Korean pages by Hangul bigrams', () => {
    const index = {
      '1': '분기별 매출액이 증가했다',
      '2': '부록 내용',
    };
    expect(rankPagesByRelevance(index, '매출액', [1, 2])).toEqual([1]);
  });

  it('ranks the page containing both Q1 and revenue', () => {
    const index = {
      '1': 'Q1 revenue beat expectations',
      '2': 'revenue outlook only',
      '3': 'Q1 weather notes',
    };
    expect(rankPagesByRelevance(index, 'Q1 revenue', [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('strips files_info blocks before tokenizing', () => {
    const index = {
      '1': 'quarterly revenue grew',
      '2': 'unrelated',
    };
    const userText =
      'quarterly revenue <files_info><file id="abc123" name="deck.pptx"></file></files_info>';
    expect(rankPagesByRelevance(index, userText, [1, 2])).toEqual([1]);
  });
});
