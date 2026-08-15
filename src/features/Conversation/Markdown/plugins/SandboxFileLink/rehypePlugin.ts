import { SKIP, visit } from 'unist-util-visit';

import { LOBE_SANDBOX_FILE_LINK_TAG, parseSandboxFileHref } from './parse';

const getNodeText = (node: any): string => {
  if (!node) return '';
  if (node.type === 'text') return String(node.value ?? '');
  if (Array.isArray(node.children)) return node.children.map(getNodeText).join('');
  return '';
};

/**
 * Rewrites `sandbox:` anchors into a custom element so the renderer can bind
 * them to the file the same assistant message already carries in `fileList`.
 */
export const rehypeSandboxFileLink = () => (tree: any) => {
  visit(tree, 'element', (node: any) => {
    if (node.tagName !== 'a') return;

    const href = node.properties?.href as string | undefined;
    const parsed = parseSandboxFileHref(href);
    if (!parsed) return;

    const text = getNodeText(node).trim();
    const label = text || parsed.fileName;

    node.tagName = LOBE_SANDBOX_FILE_LINK_TAG;
    node.children = [];
    node.properties = {
      fileName: parsed.fileName,
      filePath: parsed.filePath,
      linkLabel: label,
    };

    return SKIP;
  });
};
