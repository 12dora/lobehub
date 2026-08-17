/**
 * POST /webapi/admin/network-proxy/artifact?kind=engine|geoip|geosite
 *
 * Content-Length is required. Missing Content-Length or chunked Transfer-Encoding
 * is 411; Content-Length > 64 MiB + 64 KiB is 413. Both are rejected BEFORE the
 * body is read. After that bound, `request.formData()` is acceptable: the file is
 * capped at 64 MiB, the route is admin-only, and it is recent-reauth gated.
 * No streaming multipart parser is introduced.
 *
 * Auth: same stack as tRPC via `checkAuth` (Better Auth session cookie, or the
 * `Oidc-Auth` header). Extra headers from `createHeaderWithAuth` are accepted
 * because both checkAuth and the reauth signal reader use `req.headers`.
 */
import { checkAuth } from '@/app/(backend)/middleware/auth';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { withAdminWebapiGuard } from '@/server/enterprise/guards/adminWebapiGuard';
import {
  handleNetworkProxyArtifactUpload,
  installAuditActionFor,
  NETWORK_PROXY_AUDIT_TARGET_TYPES,
  NETWORK_PROXY_UPLOAD_PROCEDURE,
  parseArtifactKind,
} from '@/server/enterprise/routers/admin/networkProxySupport';

export const runtime = 'nodejs';

export const POST = checkAuth(async (req, ctx) => {
  const kind = parseArtifactKind(new URL(req.url).searchParams.get('kind')) ?? 'engine';
  return withAdminWebapiGuard({
    dangerous: true,
    denied: {
      action: installAuditActionFor(kind),
      targetId: kind,
      targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.ENGINE,
    },
    permission: PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE,
    procedure: NETWORK_PROXY_UPLOAD_PROCEDURE,
  })(handleNetworkProxyArtifactUpload)(req, ctx);
});
