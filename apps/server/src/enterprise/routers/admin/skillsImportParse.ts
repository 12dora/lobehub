import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import type { SkillManifest } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { sha256 } from 'js-sha256';

import { GitHub, GitHubNotFoundError, GitHubParseError } from '@/server/modules/GitHub';
import { SkillManifestError, SkillParseError } from '@/server/services/skill/errors';
import { SkillParser } from '@/server/services/skill/parser';

import type {
  AdminSkillParseImportSourceInput,
  AdminSkillParseImportSourceOutput,
  SkillResource,
} from '../../contracts/skillCatalog';

/** Decoded upload cap for the ZIP variant. */
export const MAX_IMPORT_ZIP_BYTES = 20 * 1024 * 1024;
/** Mirrors skillResourcesSchema max. */
const MAX_RESOURCES = 100;
/** Mirrors skillResourceSchema content/sizeBytes cap. */
const MAX_RESOURCE_BYTES = 1_048_576;
const MAX_CONTENT_BYTES = 1_048_576;
const FETCH_TIMEOUT_MS = 30_000;

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

const badRequest = (message: string): never => {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
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
    badRequest('Skill content exceeds the 1MB limit');
  }
  const { items, truncated } = toContractResources(params.resources);
  return {
    content: params.content,
    description: deriveDescription(params.manifest),
    displayName: deriveDisplayName(params.manifest, params.content),
    resources: items,
    ...(truncated ? { resourcesTruncated: true } : {}),
    sourceMeta: { kind: params.kind, origin: params.origin.slice(0, 2048) },
    suggestedSkillKey: sanitizeSkillKey(params.suggestedSkillKey),
  };
};

const parser = new SkillParser();
const github = new GitHub();

const parseFromGitHub = async (repoUrl: string): Promise<AdminSkillParseImportSourceOutput> => {
  let repoInfo;
  try {
    repoInfo = github.parseRepoUrl(repoUrl);
  } catch (error) {
    if (error instanceof GitHubParseError) return badRequest(error.message);
    throw error;
  }

  let zipBuffer: Buffer;
  try {
    zipBuffer = await github.downloadRepoZip(repoInfo);
  } catch (error) {
    if (error instanceof GitHubNotFoundError) {
      throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
    }
    return badRequest(`Failed to download GitHub repository: ${(error as Error).message}`);
  }

  const { content, manifest, resources } = await parser.parseZipPackage(zipBuffer, {
    basePath: repoInfo.path,
  });

  return buildOutput({
    content,
    kind: 'github',
    manifest,
    origin: repoUrl,
    resources,
    suggestedSkillKey: github.generateIdentifier(repoInfo),
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

  // ssrfSafeFetch (same boundary as the user importer) blocks private/link-local targets at
  // connect time and re-checks every redirect hop — do not replace with the raw global fetch.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await ssrfSafeFetch(rawUrl, { signal: controller.signal });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return badRequest('Fetching the URL timed out after 30 seconds');
    }
    return badRequest(`Failed to fetch URL: ${(error as Error).message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `Resource not found at ${rawUrl}` });
    }
    return badRequest(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers?.get?.('content-type') || '';
  const isZip =
    url.pathname.endsWith('.zip') ||
    url.pathname.includes('/download') ||
    contentType.includes('application/zip') ||
    contentType.includes('application/octet-stream');

  const pathPart = url.pathname.replace(/^\//, '').replace(/\.md$/i, '').replaceAll('/', '.');
  const suggestedSkillKey = `url.${url.host}.${pathPart || 'skill'}`;

  if (isZip) {
    const zipBuffer = Buffer.from(await response.arrayBuffer());
    const { content, manifest, resources } = await parser.parseZipPackage(zipBuffer);
    return buildOutput({
      content,
      kind: 'url',
      manifest,
      origin: rawUrl,
      resources,
      suggestedSkillKey,
    });
  }

  const { content, manifest } = parser.parseSkillMd(await response.text());
  return buildOutput({ content, kind: 'url', manifest, origin: rawUrl, suggestedSkillKey });
};

const parseFromZip = async (
  fileName: string,
  zipBase64: string,
): Promise<AdminSkillParseImportSourceOutput> => {
  // Cheap pre-decode guard: base64 encodes 3 bytes per 4 chars.
  if (zipBase64.length > Math.ceil(MAX_IMPORT_ZIP_BYTES / 3) * 4 + 4) {
    return badRequest('ZIP file exceeds the 20MB limit');
  }
  const buffer = Buffer.from(zipBase64, 'base64');
  if (buffer.length === 0) return badRequest('zipBase64 is not valid base64 content');
  if (buffer.length > MAX_IMPORT_ZIP_BYTES) return badRequest('ZIP file exceeds the 20MB limit');

  const { content, manifest, resources } = await parser.parseZipPackage(buffer);
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
      return badRequest(error.message);
    }
    throw error;
  }
};
