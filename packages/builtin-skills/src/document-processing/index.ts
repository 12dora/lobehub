import type { BuiltinSkill } from '@lobechat/types';

import content from './SKILL.md';

export const DocumentProcessingIdentifier = 'document-processing';

export const DocumentProcessingSkill: BuiltinSkill = {
  avatar: '📄',
  content,
  description:
    'Use when the user attaches or asks about PDF, Word/PowerPoint/Excel, archives or unknown binaries, or needs more pages, OCR, table extraction, or page images beyond what is attached',
  identifier: DocumentProcessingIdentifier,
  name: 'document-processing',
  source: 'builtin',
  title: 'Document processing',
};
