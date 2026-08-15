import { describe, expect, it } from 'vitest';

import { LOBE_SANDBOX_FILE_LINK_TAG } from './parse';
import { rehypeSandboxFileLink } from './rehypePlugin';

const createAnchor = (href: string, text: string) => ({
  children: [{ type: 'text', value: text }],
  properties: { href },
  tagName: 'a',
  type: 'element',
});

describe('rehypeSandboxFileLink', () => {
  it('rewrites sandbox links into sandbox file link nodes', () => {
    const anchor = createAnchor('sandbox:/mnt/data/aihub-uat7.pdf', '下载 aihub-uat7.pdf');
    const tree = { children: [anchor], type: 'root' };

    rehypeSandboxFileLink()(tree);

    expect(anchor).toEqual({
      children: [],
      properties: {
        fileName: 'aihub-uat7.pdf',
        filePath: '/mnt/data/aihub-uat7.pdf',
        linkLabel: '下载 aihub-uat7.pdf',
      },
      tagName: LOBE_SANDBOX_FILE_LINK_TAG,
      type: 'element',
    });
  });

  it('falls back to the file name when the anchor has no text', () => {
    const anchor = createAnchor('sandbox:/mnt/data/report.csv', '   ');
    const tree = { children: [anchor], type: 'root' };

    rehypeSandboxFileLink()(tree);

    expect((anchor.properties as any).linkLabel).toBe('report.csv');
  });

  it('keeps regular links untouched', () => {
    const anchor = createAnchor('https://example.com/a.pdf', 'a.pdf');
    const tree = { children: [anchor], type: 'root' };

    rehypeSandboxFileLink()(tree);

    expect(anchor.tagName).toBe('a');
    expect(anchor.properties).toEqual({ href: 'https://example.com/a.pdf' });
  });
});
