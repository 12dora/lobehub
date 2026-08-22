import type { BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { DocumentPagesApiName, DocumentPagesIdentifier } from './types';

export { DocumentPagesIdentifier } from './types';

export const DocumentPagesManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        'Fetch page images for an attached office document or PDF whose feed notice says page images are available. Pass the file id from <files_info> and 1–4 one-based page numbers. Use zoom "tiles" only for a single dense page that needs a close-up. At most 3 calls per turn.',
      name: DocumentPagesApiName.viewDocumentPages,
      parameters: {
        additionalProperties: false,
        properties: {
          fileId: {
            description: 'File id from <files_info> or the document feed notice.',
            type: 'string',
          },
          pages: {
            description: 'One-based page numbers to fetch (1–4 items).',
            items: { minimum: 1, type: 'integer' },
            maxItems: 4,
            minItems: 1,
            type: 'array',
          },
          zoom: {
            description:
              'page (default): whole-page image. tiles: 2×2 zoom tiles for a single dense page.',
            enum: ['page', 'tiles'],
            type: 'string',
          },
        },
        required: ['fileId', 'pages'],
        type: 'object',
      },
    },
  ],
  identifier: DocumentPagesIdentifier,
  meta: {
    avatar: '📄',
    description: 'View additional page images of attached office documents and PDFs',
    readme:
      'Fetches full-page or zoomed-tile images for documents whose page-render artifacts are ready. Use only when the document feed notice says pages are available.',
    title: 'Document Pages',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};
