import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';
import type { LobeChatDatabase } from '@/database/type';
import type { NetworkProxyArtifactKind } from '@/types/platform/networkProxy';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import type { AuditAction, AuditTargetType } from '../../services/audit/auditActionCatalog';
import {
  NETWORK_PROXY_AUDIT_ACTIONS as B1_AUDIT_ACTIONS,
  NETWORK_PROXY_AUDIT_TARGET_TYPES as B1_AUDIT_TARGET_TYPES,
} from '../../services/networkProxy/constants';
import { redactSecrets } from '../../services/networkProxy/redact';
import { sanitizeLocalError } from './networkProxyErrors';
import { getNetworkProxyRuntime } from './networkProxyRuntime';
import { installAuditActionFor } from './networkProxySettingsDiff';

const NETWORK_PROXY_AUDIT_ACTIONS = B1_AUDIT_ACTIONS as typeof B1_AUDIT_ACTIONS &
  Record<keyof typeof B1_AUDIT_ACTIONS, AuditAction>;
const NETWORK_PROXY_AUDIT_TARGET_TYPES = B1_AUDIT_TARGET_TYPES as typeof B1_AUDIT_TARGET_TYPES &
  Record<keyof typeof B1_AUDIT_TARGET_TYPES, AuditTargetType>;

export const NETWORK_PROXY_UPLOAD_PROCEDURE = 'admin.networkProxy.uploadArtifact';

/** Multipart envelope slack on top of the 64 MiB file cap (design §3.2). */
export const UPLOAD_CONTENT_LENGTH_SLACK_BYTES = 64 * 1024;

export const parseArtifactKind = (value: string | null): NetworkProxyArtifactKind | null => {
  if (value === 'engine' || value === 'geoip' || value === 'geosite') return value;
  return null;
};

export type UploadContentLengthDecision =
  { ok: true } | { code: string; ok: false; status: 411 | 413 };

/**
 * Reject unbounded or oversized bodies before any read. Content-Length is
 * required; chunked Transfer-Encoding and a missing/unparseable length are 411.
 */
export const assertUploadContentLength = (request: Request): UploadContentLengthDecision => {
  const transferEncoding = request.headers.get('transfer-encoding') ?? '';
  const isChunked = transferEncoding
    .toLowerCase()
    .split(',')
    .some((part) => part.trim() === 'chunked');
  const raw = request.headers.get('content-length');
  if (isChunked || raw === null || raw.trim() === '') {
    return { code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT, ok: false, status: 411 };
  }
  const length = Number(raw);
  if (!Number.isFinite(length) || length < 0) {
    return { code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT, ok: false, status: 411 };
  }
  if (
    length >
    NETWORK_PROXY_LIMITS.UPLOAD_MAX_COMPRESSED_BYTES + UPLOAD_CONTENT_LENGTH_SLACK_BYTES
  ) {
    return { code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT, ok: false, status: 413 };
  }
  return { ok: true };
};

export const rejectOversizedUpload = (request: Request): boolean => {
  const decision = assertUploadContentLength(request);
  return !decision.ok && decision.status === 413;
};

const fileToNodeStream = (file: File): NodeJS.ReadableStream =>
  Readable.fromWeb(file.stream() as NodeWebReadableStream);

export interface ArtifactUploadResult {
  sha256: string;
  version: string;
}

export const handleNetworkProxyArtifactUpload = async (
  request: Request,
  ctx: { serverDB: LobeChatDatabase; userId: string },
): Promise<Response> => {
  const url = new URL(request.url);
  const rawKind = url.searchParams.get('kind');
  const kind = parseArtifactKind(rawKind);
  // The admin saw the client-side digest warning and chose to install the file anyway.
  const acceptMismatch = url.searchParams.get('acceptMismatch') === '1';
  const action = installAuditActionFor(kind ?? 'engine');
  // Never persist a raw `kind` query value — it is operator-controlled.
  const auditKind = kind ?? 'invalid';

  const fail = async (params: { code: string; errorClass: string; status: number }) => {
    await appendUploadAudit(ctx, {
      action,
      afterDiff: { error: params.errorClass, kind: auditKind, source: 'upload' },
      result: 'failure',
    }).catch((auditError: unknown) => {
      console.error('[admin.networkProxy] upload failure audit failed', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    });
    return jsonCode(params.code, params.status);
  };

  try {
    const lengthDecision = assertUploadContentLength(request);
    if (!lengthDecision.ok) {
      return await fail({
        code: lengthDecision.code,
        errorClass: lengthDecision.status === 413 ? 'payload_too_large' : 'length_required',
        status: lengthDecision.status,
      });
    }

    if (!kind) {
      return await fail({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        errorClass: 'invalid_kind',
        status: 400,
      });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return await fail({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        errorClass: 'multipart_parse',
        status: 400,
      });
    }

    const file = formData.get('file');
    if (!(file instanceof File)) {
      return await fail({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        errorClass: 'missing_file',
        status: 400,
      });
    }
    if (file.size > NETWORK_PROXY_LIMITS.UPLOAD_MAX_COMPRESSED_BYTES) {
      return await fail({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        errorClass: 'payload_too_large',
        status: 413,
      });
    }

    const runtime = await getNetworkProxyRuntime();
    const installed = await runtime.artifactManager.installFromStream(
      kind,
      fileToNodeStream(file),
      {
        acceptMismatch,
        compressed: 'auto',
        source: 'upload',
      },
    );

    await runtime.reportLocalInstanceStatus?.().catch(() => false);

    await appendUploadAudit(ctx, {
      action,
      afterDiff: {
        kind,
        pinnedDigestMatch: installed.pinnedDigestMatch,
        sha256: installed.sha256,
        source: 'upload',
        version: installed.version,
      },
      result: 'success',
    });

    return Response.json(
      {
        ok: true,
        pinnedDigestMatch: installed.pinnedDigestMatch,
        sha256: installed.sha256,
        version: installed.version,
      },
      { status: 200 },
    );
  } catch (error) {
    const code = resolveUploadErrorCode(error);
    return await fail({
      code,
      errorClass: sanitizeLocalError(error, redactSecrets),
      status: statusForUploadCode(code),
    });
  }
};

const resolveUploadErrorCode = (error: unknown): string => {
  // Enterprise errors (`throwNetworkProxyError`) carry the platform code in `cause.data`; the
  // top-level `code` on those is the tRPC code (BAD_REQUEST…), which is not what the client maps.
  const platform = getEnterpriseErrorBody(error)?.code;
  if (typeof platform === 'string' && platform in PLATFORM_ERROR_CODES) return platform;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: string }).code;
    if (typeof code === 'string' && code in PLATFORM_ERROR_CODES) return code;
  }
  if (error instanceof Error && error.message in PLATFORM_ERROR_CODES) return error.message;
  return PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ENGINE_ERROR;
};

const statusForUploadCode = (code: string): number => {
  if (code === PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH) return 400;
  if (code === PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNSUPPORTED_PLATFORM) return 400;
  if (code === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT) return 400;
  if (code === PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ENGINE_NOT_INSTALLED) return 409;
  return 500;
};

const jsonCode = (code: string, status: number) => Response.json({ code }, { status });

const appendUploadAudit = async (
  ctx: { serverDB: LobeChatDatabase; userId: string },
  input: {
    action: (typeof NETWORK_PROXY_AUDIT_ACTIONS)[keyof typeof NETWORK_PROXY_AUDIT_ACTIONS];
    afterDiff: Record<string, unknown>;
    result: 'failure' | 'success';
  },
) => {
  const { PlatformAuditService } = await import('../../services/platformAudit');
  await new PlatformAuditService(ctx.serverDB).append({
    action: input.action,
    actorUserId: ctx.userId,
    afterDiff: input.afterDiff,
    result: input.result,
    targetId: input.action === NETWORK_PROXY_AUDIT_ACTIONS.ENGINE_INSTALL ? 'engine' : 'geodata',
    targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.ENGINE,
  });
};
