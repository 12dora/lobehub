import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import type { SkillManifest } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { unzip as fflateUnzip } from 'fflate';
import { sha256 } from 'js-sha256';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { GitHub, GitHubParseError } from '@/server/modules/GitHub';
import { SkillManifestError, SkillParseError } from '@/server/services/skill/errors';
import { SkillParser } from '@/server/services/skill/parser';

import { isStrictSemVer } from '../../contracts/shared';
import type {
  AdminSkillParseImportSourceInput,
  AdminSkillParseImportSourceOutput,
  SkillManifest as EnterpriseSkillManifest,
  SkillResource,
} from '../../contracts/skillCatalog';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';

/** Decoded upload / remote ZIP compressed-byte cap. */
export const MAX_IMPORT_ZIP_BYTES = 20 * 1024 * 1024;
/** Total uncompressed entry-byte cap (ZIP bomb guard). */
export const MAX_IMPORT_ZIP_EXPANDED_BYTES = 50 * 1024 * 1024;
/** Mirrors skillResourcesSchema max. */
const MAX_RESOURCES = 100;
/** Mirrors skillResourceSchema content/sizeBytes cap. */
const MAX_RESOURCE_BYTES = 1_048_576;
const MAX_CONTENT_BYTES = 1_048_576;
const FETCH_TIMEOUT_MS = 30_000;

/** Stable machine-readable import failure reasons (client maps to i18n). */
export const SKILL_IMPORT_ERROR_REASONS = {
  CONTENT_TOO_LARGE: 'skill_import_content_too_large',
  FETCH_FAILED: 'skill_import_fetch_failed',
  INVALID_ZIP: 'skill_import_invalid_zip',
  NOT_FOUND: 'skill_import_not_found',
  PARSE_FAILED: 'skill_import_parse_failed',
  TIMEOUT: 'skill_import_timeout',
  ZIP_TOO_LARGE: 'skill_import_zip_too_large',
} as const;

export type SkillImportErrorReason =
  (typeof SKILL_IMPORT_ERROR_REASONS)[keyof typeof SKILL_IMPORT_ERROR_REASONS];

const MEDIA_TYPES: Record<string, string> = {
  css: 'text/css',
  csv: 'text/csv',
  html: 'text/html',
  js: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown',
  mjs: 'text/javascript',
  py: 'text/x-python',
  sh: 'text/x-shellscript',
  svg: 'image/svg+xml',
  toml: 'application/toml',
  ts: 'text/typescript',
  txt: 'text/plain',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
};

const mediaTypeFor = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_TYPES[ext] ?? 'text/plain';
};

/**
 * Conform an arbitrary derived identifier to the skillKey contract charset
 * (/^[a-z0-9][a-z0-9._-]*$/, max 128).
 */
export const sanitizeSkillKey = (raw: string): string => {
  const sanitized = raw
    .toLowerCase()
    .replaceAll(/[^\d.a-z_-]+/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 128)
    .replace(/[._-]+$/, '');
  return sanitized || 'imported-skill';
};

const isSafeResourcePath = (path: string): boolean =>
  path.length > 0 &&
  path.length <= 512 &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');

/**
 * Convert parser resources (Map<path, Buffer>) into the skillCatalog contract shape.
 * Only UTF-8 text resources within the per-file cap survive; anything dropped flips `truncated`.
 */
const toContractResources = (
  resources: Map<string, Buffer> | undefined,
): { items: SkillResource[]; truncated: boolean } => {
  const items: SkillResource[] = [];
  let truncated = false;
  if (!resources || resources.size === 0) return { items, truncated };

  for (const path of [...resources.keys()].sort()) {
    const buffer = resources.get(path)!;
    if (items.length >= MAX_RESOURCES) {
      truncated = true;
      break;
    }
    if (!isSafeResourcePath(path) || buffer.length > MAX_RESOURCE_BYTES) {
      truncated = true;
      continue;
    }
    const content = buffer.toString('utf8');
    // Round-trip check rejects binary payloads that cannot survive the text contract.
    if (!Buffer.from(content, 'utf8').equals(buffer)) {
      truncated = true;
      continue;
    }
    items.push({
      checksum: sha256(content),
      content,
      mediaType: mediaTypeFor(path),
      path,
      sizeBytes: buffer.length,
    });
  }
  return { items, truncated };
};

const deriveDisplayName = (manifest: SkillManifest, content: string): string => {
  const fromManifest = manifest.name?.trim();
  if (fromManifest) return fromManifest.slice(0, 200);
  const heading = content.match(/^#{1,6}[ \t]+(\S.*)$/m)?.[1]?.trim();
  if (heading) return heading.slice(0, 200);
  return 'Imported Skill';
};

const deriveDescription = (manifest: SkillManifest): string | null => {
  const description = manifest.description?.trim();
  return description ? description.slice(0, 4000) : null;
};

/** Hostname shape accepted by enterprise skillPermissionsSchema.network.allowedHosts. */
const ALLOWED_HOST_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const TOOL_KEY_RE = /^[a-z0-9][\w.-]{0,127}$/i;
const SKILL_KEY_RE = /^[a-z0-9][\w.-]*$/i;

const uniquePreserveOrder = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

/**
 * Map free-form package permission tokens into enterprise grants.
 * Unknown / non-compatible tokens are ignored (fail closed — no silent over-grant).
 *
 * Compatible tokens:
 * - `filesystem` | `filesystem:read` | `fs:read` → filesystem:read
 * - `network:<hostname>` → network host allowlist (+ enabled when non-empty)
 * - bare `network` is ignored (requires explicit hosts to stay validator-consistent)
 * - `tool:<key>` → tools.allow (+ matching optional toolDependencies)
 * Bare unknown tokens are ignored (fail closed — no silent over-grant).
 */
export const mapPackagePermissionTokens = (
  tokens: readonly string[] | undefined,
): Pick<EnterpriseSkillManifest, 'permissions' | 'toolDependencies'> => {
  let filesystem: 'none' | 'read' = 'none';
  const allowedHosts: string[] = [];
  const toolKeys: string[] = [];

  for (const raw of tokens ?? []) {
    if (typeof raw !== 'string') continue;
    const token = raw.trim();
    if (!token) continue;
    const lower = token.toLowerCase();

    if (lower === 'filesystem' || lower === 'filesystem:read' || lower === 'fs:read') {
      filesystem = 'read';
      continue;
    }

    if (lower === 'network' || lower === 'filesystem:none' || lower === 'none') {
      // Bare network cannot enable without hosts; explicit none stays closed.
      continue;
    }

    const networkHost = token.match(/^network:(.+)$/i)?.[1]?.trim();
    if (networkHost) {
      if (networkHost.length <= 253 && ALLOWED_HOST_RE.test(networkHost)) {
        allowedHosts.push(networkHost.toLowerCase());
      }
      continue;
    }

    // Only explicit tool: prefixes become Tool grants (bare free-form strings stay ignored).
    const toolKey = token.match(/^tool:(.+)$/i)?.[1]?.trim();
    if (toolKey && TOOL_KEY_RE.test(toolKey)) {
      toolKeys.push(toolKey);
    }
  }

  const allow = uniquePreserveOrder(toolKeys).slice(0, 100);
  const hosts = uniquePreserveOrder(allowedHosts).slice(0, 50);
  return {
    permissions: {
      filesystem,
      network: { allowedHosts: hosts, enabled: hosts.length > 0 },
      tools: { allow },
    },
    // Optional so unknown/unavailable tools surface as warnings, not hard publish blockers.
    toolDependencies: allow.map((toolKey) => ({ optional: true, toolKey })),
  };
};

const mapPackageSkillDependencies = (
  raw: unknown,
): EnterpriseSkillManifest['skillDependencies'] => {
  if (!Array.isArray(raw)) return [];
  const deps: EnterpriseSkillManifest['skillDependencies'] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const skillKey = typeof record.skillKey === 'string' ? record.skillKey.trim() : '';
    const version = typeof record.version === 'string' ? record.version.trim() : '';
    if (!skillKey || !SKILL_KEY_RE.test(skillKey) || skillKey.length > 128) continue;
    if (!version || !isStrictSemVer(version)) continue;
    deps.push({
      optional: record.optional === true,
      skillKey,
      version,
    });
    if (deps.length >= 100) break;
  }
  return deps;
};

const mapPackageToolDependencies = (raw: unknown): EnterpriseSkillManifest['toolDependencies'] => {
  if (!Array.isArray(raw)) return [];
  const deps: EnterpriseSkillManifest['toolDependencies'] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const toolKey = typeof record.toolKey === 'string' ? record.toolKey.trim() : '';
    if (!toolKey || !TOOL_KEY_RE.test(toolKey) || seen.has(toolKey)) continue;
    seen.add(toolKey);
    deps.push({ optional: record.optional === true, toolKey });
    if (deps.length >= 100) break;
  }
  return deps;
};

/**
 * Convert a package SkillManifest into the enterprise platform Skill manifest.
 * Compatible permission tokens and optional package dependency declarations are preserved;
 * unrecognized metadata is dropped (fail closed).
 */
export const toEnterpriseSkillManifest = (params: {
  description: string | null;
  displayName: string;
  /** Full package manifest (permissions + optional passthrough dependency fields). */
  packageManifest?: SkillManifest;
}): EnterpriseSkillManifest => {
  const packageManifest = params.packageManifest;
  const fromTokens = mapPackagePermissionTokens(packageManifest?.permissions);

  // Optional package-level dependency declarations (passthrough fields).
  const packageRecord = packageManifest as (SkillManifest & Record<string, unknown>) | undefined;
  const skillDependencies = mapPackageSkillDependencies(packageRecord?.skillDependencies);
  const declaredToolDeps = mapPackageToolDependencies(packageRecord?.toolDependencies);

  // Merge tool deps from tokens + explicit declarations; required allowlist tools stay required.
  const toolDepByKey = new Map<string, { optional: boolean; toolKey: string }>();
  for (const dep of [...fromTokens.toolDependencies, ...declaredToolDeps]) {
    const existing = toolDepByKey.get(dep.toolKey);
    if (!existing) {
      toolDepByKey.set(dep.toolKey, dep);
      continue;
    }
    // Prefer required (optional:false) when either declaration is required.
    if (!dep.optional) toolDepByKey.set(dep.toolKey, { optional: false, toolKey: dep.toolKey });
  }
  const toolDependencies = [...toolDepByKey.values()].slice(0, 100);
  const allow = uniquePreserveOrder([
    ...fromTokens.permissions.tools.allow,
    ...toolDependencies.map((d) => d.toolKey),
  ]).slice(0, 100);

  return {
    description: params.description?.trim() || params.displayName,
    displayName: params.displayName,
    localizedDescriptions: {},
    localizedDisplayNames: {},
    permissions: {
      filesystem: fromTokens.permissions.filesystem,
      network: fromTokens.permissions.network,
      tools: { allow },
    },
    skillDependencies,
    toolDependencies,
  };
};

const derivePackageVersion = (manifest: SkillManifest): string | undefined => {
  const version = manifest.version?.trim();
  if (!version || !isStrictSemVer(version)) return undefined;
  return version;
};

const importError = (
  reason: SkillImportErrorReason,
  options?: { httpCode?: 'BAD_REQUEST' | 'NOT_FOUND'; status?: number },
): never => {
  const httpCode =
    options?.httpCode ??
    (reason === SKILL_IMPORT_ERROR_REASONS.NOT_FOUND ? 'NOT_FOUND' : 'BAD_REQUEST');
  const code =
    reason === SKILL_IMPORT_ERROR_REASONS.NOT_FOUND
      ? PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND
      : PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;
  return throwEnterpriseError({
    code,
    details: {
      reason,
      ...(typeof options?.status === 'number' ? { status: options.status } : {}),
    },
    httpCode,
    message: reason,
  });
};

const buildOutput = (params: {
  content: string;
  kind: 'github' | 'url' | 'zip';
  manifest: SkillManifest;
  origin: string;
  resources?: Map<string, Buffer>;
  suggestedSkillKey: string;
}): AdminSkillParseImportSourceOutput => {
  if (Buffer.byteLength(params.content, 'utf8') > MAX_CONTENT_BYTES) {
    return importError(SKILL_IMPORT_ERROR_REASONS.CONTENT_TOO_LARGE);
  }
  const { items, truncated } = toContractResources(params.resources);
  const displayName = deriveDisplayName(params.manifest, params.content);
  const description = deriveDescription(params.manifest);
  const packageVersion = derivePackageVersion(params.manifest);
  return {
    content: params.content,
    description,
    displayName,
    manifest: toEnterpriseSkillManifest({
      description,
      displayName,
      packageManifest: params.manifest,
    }),
    ...(packageVersion ? { packageVersion } : {}),
    resources: items,
    ...(truncated ? { resourcesTruncated: true } : {}),
    sourceMeta: { kind: params.kind, origin: params.origin.slice(0, 2048) },
    suggestedSkillKey: sanitizeSkillKey(params.suggestedSkillKey),
  };
};

const parser = new SkillParser();
const github = new GitHub();

/**
 * Consume a response body with an active abort deadline and a hard byte cap.
 * Rejects oversized Content-Length before reading; aborts on chunked oversize.
 */
export const readResponseBodyWithLimit = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> => {
  const contentLengthHeader = response.headers?.get?.('content-length');
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel errors
      }
      return importError(
        maxBytes >= MAX_IMPORT_ZIP_BYTES
          ? SKILL_IMPORT_ERROR_REASONS.ZIP_TOO_LARGE
          : SKILL_IMPORT_ERROR_REASONS.CONTENT_TOO_LARGE,
      );
    }
  }

  if (signal.aborted) {
    return importError(SKILL_IMPORT_ERROR_REASONS.TIMEOUT);
  }

  // Prefer streaming when available so we can abort mid-body.
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) {
          await reader.cancel().catch(() => undefined);
          return importError(SKILL_IMPORT_ERROR_REASONS.TIMEOUT);
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return importError(
            maxBytes >= MAX_IMPORT_ZIP_BYTES
              ? SKILL_IMPORT_ERROR_REASONS.ZIP_TOO_LARGE
              : SKILL_IMPORT_ERROR_REASONS.CONTENT_TOO_LARGE,
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      if (signal.aborted || (error as Error).name === 'AbortError') {
        return importError(SKILL_IMPORT_ERROR_REASONS.TIMEOUT);
      }
      throw error;
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  // Fallback when body is not a stream (e.g. undici Response polyfills in tests).
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    return importError(
      maxBytes >= MAX_IMPORT_ZIP_BYTES
        ? SKILL_IMPORT_ERROR_REASONS.ZIP_TOO_LARGE
        : SKILL_IMPORT_ERROR_REASONS.CONTENT_TOO_LARGE,
    );
  }
  return buffer;
};

/**
 * Expand a ZIP and reject when total uncompressed bytes exceed the hard cap.
 * Uses declared originalSize when present and re-checks actual decoded lengths.
 */
export const assertZipExpandedWithinLimit = async (buffer: Buffer): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let declaredTotal = 0;
    fflateUnzip(
      new Uint8Array(buffer),
      {
        filter(file) {
          const size =
            typeof file.originalSize === 'number' && Number.isFinite(file.originalSize)
              ? file.originalSize
              : 0;
          declaredTotal += size;
          if (declaredTotal > MAX_IMPORT_ZIP_EXPANDED_BYTES) {
            return false;
          }
          return true;
        },
      },
      (error, files) => {
        const fail = (reason: SkillImportErrorReason) => {
          try {
            importError(reason);
          } catch (err) {
            reject(err);
          }
        };

        if (declaredTotal > MAX_IMPORT_ZIP_EXPANDED_BYTES) {
          fail(SKILL_IMPORT_ERROR_REASONS.ZIP_TOO_LARGE);
          return;
        }
        if (error) {
          fail(SKILL_IMPORT_ERROR_REASONS.INVALID_ZIP);
          return;
        }

        let actual = 0;
        for (const data of Object.values(files)) {
          actual += data.byteLength;
          if (actual > MAX_IMPORT_ZIP_EXPANDED_BYTES) {
            fail(SKILL_IMPORT_ERROR_REASONS.ZIP_TOO_LARGE);
            return;
          }
        }
        resolve();
      },
    );
  });
};

const parseZipBuffer = async (
  buffer: Buffer,
  options?: { basePath?: string },
): Promise<Awaited<ReturnType<SkillParser['parseZipPackage']>>> => {
  await assertZipExpandedWithinLimit(buffer);
  return parser.parseZipPackage(buffer, options);
};

/**
 * Deadline-aware, byte-capped GitHub archive download (does not use unbounded
 * GitHub.downloadRepoZip buffering).
 */
const downloadGitHubZipWithLimit = async (
  repoUrl: string,
): Promise<{
  basePath?: string;
  suggestedSkillKey: string;
  zipBuffer: Buffer;
}> => {
  let repoInfo;
  try {
    repoInfo = github.parseRepoUrl(repoUrl);
  } catch (error) {
    if (error instanceof GitHubParseError) {
      return importError(SKILL_IMPORT_ERROR_REASONS.PARSE_FAILED);
    }
    throw error;
  }

  const zipUrl = github.buildRepoZipUrl(repoInfo);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      // maxContentLength is enforced inside ssrfSafeFetch (streaming cap) so a huge
      // body cannot fully materialize via arrayBuffer() before our post-hoc reader runs.
      response = await ssrfSafeFetch(
        zipUrl,
        {
          headers: { 'User-Agent': 'LobeHub' },
          signal: controller.signal,
        },
        { maxContentLength: MAX_IMPORT_ZIP_BYTES },
      );
    } catch (error) {
      if ((error as Error).name === 'AbortError' || controller.signal.aborted) {
        return importError(SKILL_IMPORT_ERROR_REASONS.TIMEOUT);
      }
      return importError(SKILL_IMPORT_ERROR_REASONS.FETCH_FAILED);
    }

    if (!response.ok) {
      if (response.status === 404) {
        return importError(SKILL_IMPORT_ERROR_REASONS.NOT_FOUND, { httpCode: 'NOT_FOUND' });
      }
      return importError(SKILL_IMPORT_ERROR_REASONS.FETCH_FAILED, { status: response.status });
    }

    const zipBuffer = await readResponseBodyWithLimit(
      response,
      MAX_IMPORT_ZIP_BYTES,
      controller.signal,
    );
    return {
      basePath: repoInfo.path,
      suggestedSkillKey: github.generateIdentifier(repoInfo),
      zipBuffer,
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

const parseFromGitHub = async (repoUrl: string): Promise<AdminSkillParseImportSourceOutput> => {
  const { basePath, suggestedSkillKey, zipBuffer } = await downloadGitHubZipWithLimit(repoUrl);
  const { content, manifest, resources } = await parseZipBuffer(zipBuffer, { basePath });

  return buildOutput({
    content,
    kind: 'github',
    manifest,
    origin: repoUrl,
    resources,
    suggestedSkillKey,
  });
};

const parseFromUrl = async (rawUrl: string): Promise<AdminSkillParseImportSourceOutput> => {
  const url = new URL(rawUrl);

  // Mirror user importFromUrl: repo/tree/blob GitHub URLs go through the repo-zip path so
  // subdirectory skills resolve; direct download URLs fall through to the generic fetch.
  if (
    url.hostname === 'github.com' &&
    /^\/[^/]+\/[^/]+(?:\/(?:tree|blob)\/.+)?$/.test(url.pathname.replace(/\/+$/, ''))
  ) {
    return parseFromGitHub(rawUrl);
  }

  // Deadline covers headers AND body consumption — never clear before the body is fully read.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  // Fetch with the ZIP ceiling so extensionless / signed URLs serving application/zip
  // are not truncated at the 1 MiB markdown cap before Content-Type is known. Text
  // responses are still enforced at MAX_CONTENT_BYTES after classification.
  const fetchMaxBytes = MAX_IMPORT_ZIP_BYTES;
  try {
    let response: Response;
    try {
      // Cap at the fetch layer so ssrfSafeFetch never fully buffers an unbounded body.
      response = await ssrfSafeFetch(
        rawUrl,
        { signal: controller.signal },
        { maxContentLength: fetchMaxBytes },
      );
    } catch (error) {
      if ((error as Error).name === 'AbortError' || controller.signal.aborted) {
        return importError(SKILL_IMPORT_ERROR_REASONS.TIMEOUT);
      }
      return importError(SKILL_IMPORT_ERROR_REASONS.FETCH_FAILED);
    }

    if (!response.ok) {
      if (response.status === 404) {
        return importError(SKILL_IMPORT_ERROR_REASONS.NOT_FOUND, {
          httpCode: 'NOT_FOUND',
          status: 404,
        });
      }
      return importError(SKILL_IMPORT_ERROR_REASONS.FETCH_FAILED, { status: response.status });
    }

    const contentType = response.headers?.get?.('content-type') || '';
    const isZip =
      url.pathname.endsWith('.zip') ||
      url.pathname.includes('/download') ||
      contentType.includes('application/zip') ||
      contentType.includes('application/octet-stream');

    const pathPart = url.pathname.replace(/^\//, '').replace(/\.md$/i, '').replaceAll('/', '.');
    const suggestedSkillKey = `url.${url.host}.${pathPart || 'skill'}`;
    const maxBytes = isZip ? MAX_IMPORT_ZIP_BYTES : MAX_CONTENT_BYTES;
    const body = await readResponseBodyWithLimit(response, maxBytes, controller.signal);

    if (isZip) {
      const { content, manifest, resources } = await parseZipBuffer(body);
      return buildOutput({
        content,
        kind: 'url',
        manifest,
        origin: rawUrl,
        resources,
        suggestedSkillKey,
      });
    }

    const { content, manifest } = parser.parseSkillMd(body.toString('utf8'));
    return buildOutput({ content, kind: 'url', manifest, origin: rawUrl, suggestedSkillKey });
  } finally {
    clearTimeout(timeoutId);
  }
};

const parseFromZip = async (
  fileName: string,
  zipBase64: string,
): Promise<AdminSkillParseImportSourceOutput> => {
  // Cheap pre-decode guard: base64 encodes 3 bytes per 4 chars.
  if (zipBase64.length > Math.ceil(MAX_IMPORT_ZIP_BYTES / 3) * 4 + 4) {
    return importError(SKILL_IMPORT_ERROR_REASONS.ZIP_TOO_LARGE);
  }
  const buffer = Buffer.from(zipBase64, 'base64');
  if (buffer.length === 0) return importError(SKILL_IMPORT_ERROR_REASONS.INVALID_ZIP);
  if (buffer.length > MAX_IMPORT_ZIP_BYTES) {
    return importError(SKILL_IMPORT_ERROR_REASONS.ZIP_TOO_LARGE);
  }

  const { content, manifest, resources } = await parseZipBuffer(buffer);
  return buildOutput({
    content,
    kind: 'zip',
    manifest,
    origin: fileName,
    resources,
    suggestedSkillKey: manifest.name?.trim() || fileName.replace(/\.zip$/i, ''),
  });
};

/**
 * Parse a skill package for the admin import preview. Fetch/parse only — no database writes,
 * no file-storage writes, no user rows. The caller publishes via admin.skills.applyImmediate.
 */
export const parseSkillImportSource = async (
  input: AdminSkillParseImportSourceInput,
): Promise<AdminSkillParseImportSourceOutput> => {
  try {
    switch (input.source) {
      case 'github': {
        return await parseFromGitHub(input.repoUrl);
      }
      case 'url': {
        return await parseFromUrl(input.url);
      }
      case 'zip': {
        return await parseFromZip(input.fileName, input.zipBase64);
      }
    }
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof SkillParseError || error instanceof SkillManifestError) {
      return importError(SKILL_IMPORT_ERROR_REASONS.PARSE_FAILED);
    }
    throw error;
  }
};
