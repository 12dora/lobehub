import { type FC } from 'react';

import { type MarkdownElement, type MarkdownElementProps } from '../type';
import { LOBE_SANDBOX_FILE_LINK_TAG } from './parse';
import { rehypeSandboxFileLink } from './rehypePlugin';
import Render from './Render';

const SandboxFileLinkElement: MarkdownElement = {
  Component: Render as FC<MarkdownElementProps>,
  rehypePlugin: rehypeSandboxFileLink,
  // `sandbox:` links are emitted by sandboxed providers in their answers, so
  // only assistant-side markdown needs to resolve them.
  scope: 'assistant',
  tag: LOBE_SANDBOX_FILE_LINK_TAG,
};

export default SandboxFileLinkElement;
