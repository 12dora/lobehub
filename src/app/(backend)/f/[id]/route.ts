import debug from 'debug';
import { and, eq, isNull } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import { platformBrandingAssets } from '@/database/schemas/platform';
import { getServerDB } from '@/database/server';
import { isPlatformBrandingAssetId } from '@/server/enterprise/contracts/adminBranding';
import { FileService } from '@/server/services/file';
import { createFileServiceModule } from '@/server/services/file/impls';

const log = debug('lobe-file:proxy');
const redirectToObject = (location: string, mimeType: string): Response =>
  new Response(null, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': mimeType,
      'Location': location,
      'X-Content-Type-Options': 'nosniff',
    },
    status: 302,
  });

type Params = Promise<{ id: string }>;

/**
 * File proxy service
 * GET /f/:id
 *
 * Features:
 * - Query database to get file record (without userId filter for public access)
 * - Generate a temporary S3 presigned preview URL
 * - Return 302 redirect
 *
 * NOTE: This endpoint is intentionally unauthenticated. The proxy URL is
 * embedded in bare `<img>` tags, download links, and links shared to AI — none
 * of which can attach auth headers/cookies. Adding `checkAuth` here would break
 * every previously-shared `/f/:id` link, so access stays public by id.
 */
export const GET = async (_req: Request, segmentData: { params: Params }) => {
  try {
    const params = await segmentData.params;
    const { id } = params;

    log('File proxy request: %s', id);

    // Get database connection
    const db = await getServerDB();

    if (id.startsWith('pba_')) {
      if (!isPlatformBrandingAssetId(id)) return new Response('File not found', { status: 404 });
      const [asset] = await db
        .select({
          mimeType: platformBrandingAssets.mimeType,
          objectKey: platformBrandingAssets.objectKey,
        })
        .from(platformBrandingAssets)
        .where(
          and(
            eq(platformBrandingAssets.id, id),
            eq(platformBrandingAssets.status, 'ready'),
            isNull(platformBrandingAssets.objectDeletedAt),
          ),
        )
        .limit(1);
      if (!asset) return new Response('File not found', { status: 404 });
      const redirectUrl = await createFileServiceModule(db).createCachedPreSignedUrlForPreview(
        asset.objectKey,
      );
      return redirectToObject(redirectUrl, asset.mimeType);
    }

    // Query file record without userId filter (public access)
    const file = await FileModel.getFileById(db, id);

    if (!file) {
      log('File not found: %s', id);
      return new Response('File not found', {
        status: 404,
      });
    }

    // Create file service with file owner's userId
    const fileService = new FileService(db, file.userId);

    // Web: Generate a cached S3 presigned URL, normalizing legacy full S3 URLs.
    const redirectUrl = await fileService.createCachedPreSignedUrlForPreview(file.url);
    log('Web S3 presigned URL generated');

    // Return 302 redirect
    return Response.redirect(redirectUrl, 302);
  } catch (error) {
    console.error('File proxy error:', error);
    return new Response('Internal server error', {
      status: 500,
    });
  }
};
