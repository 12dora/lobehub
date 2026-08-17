import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import type { SkillManifest } from '@lobechat/types';
import { TRPCError } from '@trpc/server';

import {
  getCurrentEgressScope,
  runWithEgressScope,
} from '@/server/enterprise/services/networkProxy';
import { GitHub, GitHubParseError } from '@/server/modules/GitHub';
import { SkillManifestError, SkillParseError } from '@/server/services/skill/errors';

import type {
  AdminSkillParseImportSourceInput,
  AdminSkillParseImportSourceOutput,
} from '../../contracts/skillCatalog';
import { importError, SKILL_IMPORT_ERROR_REASONS } from './skillImport/errors';
import {
  FETCH_TIMEOUT_MS,
  MAX_CONTENT_BYTES,
  MAX_IMPORT_ZIP_BYTES,
  parseZipBuffer,
  readResponseBodyWithLimit,
} from './skillImport/fetch';
import {
  deriveDescription,
  deriveDisplayName,
  derivePackageVersion,
  parser,
  sanitizeSkillKey,
  toContractResources,
  toEnterpriseSkillManifest,
} from './skillImport/manifest';

export type { SkillImportErrorReason } from './skillImport/errors';
export { SKILL_IMPORT_ERROR_REASONS } from './skillImport/errors';
export {
  assertZipExpandedWithinLimit,
  MAX_IMPORT_ZIP_BYTES,
  MAX_IMPORT_ZIP_EXPANDED_BYTES,
  readResponseBodyWithLimit,
} from './skillImport/fetch';
export {
  mapPackagePermissionTokens,
  sanitizeSkillKey,
  toEnterpriseSkillManifest,
} from './skillImport/manifest';

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

const github = new GitHub();

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
  if (getCurrentEgressScope() !== 'feature:import_fetch') {
    return runWithEgressScope('feature:import_fetch', () => downloadGitHubZipWithLimit(repoUrl));
  }
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
  if (getCurrentEgressScope() !== 'feature:import_fetch') {
    return runWithEgressScope('feature:import_fetch', () => parseFromUrl(rawUrl));
  }
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
