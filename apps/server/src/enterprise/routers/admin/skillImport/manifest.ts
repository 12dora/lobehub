import type { SkillManifest } from '@lobechat/types';
import { sha256 } from 'js-sha256';

import { SkillParser } from '@/server/services/skill/parser';

import { isStrictSemVer } from '../../../contracts/shared';
import type {
  SkillManifest as EnterpriseSkillManifest,
  SkillResource,
} from '../../../contracts/skillCatalog';

export const parser = new SkillParser();

/** Mirrors skillResourcesSchema max. */
const MAX_RESOURCES = 100;
/** Mirrors skillResourceSchema content/sizeBytes cap. */
const MAX_RESOURCE_BYTES = 1_048_576;

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
export const toContractResources = (
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

export const deriveDisplayName = (manifest: SkillManifest, content: string): string => {
  const fromManifest = manifest.name?.trim();
  if (fromManifest) return fromManifest.slice(0, 200);
  const heading = content.match(/^#{1,6}[ \t]+(\S.*)$/m)?.[1]?.trim();
  if (heading) return heading.slice(0, 200);
  return 'Imported Skill';
};

export const deriveDescription = (manifest: SkillManifest): string | null => {
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

export const derivePackageVersion = (manifest: SkillManifest): string | undefined => {
  const version = manifest.version?.trim();
  if (!version || !isStrictSemVer(version)) return undefined;
  return version;
};
