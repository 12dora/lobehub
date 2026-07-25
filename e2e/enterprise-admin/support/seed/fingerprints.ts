/**
 * Stable fingerprints and row mappers for CAS after-state equality.
 */
import { createHash } from 'node:crypto';

import type { ManagedPolicyRow, PlatformPermissionRow, PlatformRoleRow } from './types';

export const policyFingerprint = (row: ManagedPolicyRow): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        config: row.config,
        enforcement: row.enforcement,
        id: row.id,
        resource: row.resource,
        revision: row.revision,
        status: row.status,
      }),
    )
    .digest('hex');

/** Stable ISO for timestamptz values from node-pg Date or string. */
export const tsIso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return value;
  }
  return String(value ?? '');
};

/** Canonical JSON for jsonb metadata (sorted keys, null-stripped empty → {}). */
export const canonicalizeJson = (value: unknown): string => {
  const normalize = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(normalize);
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        const n = normalize(obj[key]);
        if (n !== null && n !== undefined) out[key] = n;
      }
      return out;
    }
    return v;
  };
  const n = normalize(value);
  return JSON.stringify(n === null ? {} : n);
};

/** Canonical permission after-state fingerprint (every stored column). */
export const permissionFingerprint = (row: {
  category: string;
  code: string;
  createdAt: string;
  description: string;
  id: string;
  isActive: boolean;
  name: string;
  updatedAt: string;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        category: row.category,
        code: row.code,
        createdAt: row.createdAt,
        description: row.description,
        id: row.id,
        isActive: row.isActive,
        name: row.name,
        updatedAt: row.updatedAt,
      }),
    )
    .digest('hex');

/** Canonical role after-state fingerprint (every stored column). */
export const roleFingerprint = (row: {
  createdAt: string;
  description: string;
  displayName: string;
  id: string;
  isActive: boolean;
  isSystem: boolean;
  metadata: string;
  name: string;
  updatedAt: string;
  workspaceId: null | string;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        createdAt: row.createdAt,
        description: row.description,
        displayName: row.displayName,
        id: row.id,
        isActive: row.isActive,
        isSystem: row.isSystem,
        metadata: row.metadata,
        name: row.name,
        updatedAt: row.updatedAt,
        workspaceId: row.workspaceId,
      }),
    )
    .digest('hex');

/** Fingerprint includes created_at so delete+reinsert of the same composite key diverges. */
export const rolePermissionLinkFingerprint = (row: {
  createdAt: string;
  permissionId: string;
  roleId: string;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        createdAt: row.createdAt,
        permissionId: row.permissionId,
        roleId: row.roleId,
      }),
    )
    .digest('hex');

export const userRoleLinkFingerprint = (row: {
  createdAt: string;
  expiresAt: null | string;
  id: string;
  roleId: string;
  userId: string;
  workspaceId: null | string;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        id: row.id,
        roleId: row.roleId,
        userId: row.userId,
        workspaceId: row.workspaceId,
      }),
    )
    .digest('hex');

export const mapPermissionRow = (row: Record<string, unknown>): PlatformPermissionRow => {
  const base = {
    category: String(row.category ?? ''),
    code: String(row.code),
    createdAt: tsIso(row.created_at ?? row.createdAt),
    description: row.description == null ? '' : String(row.description),
    id: String(row.id),
    isActive: Boolean(row.is_active ?? row.isActive ?? true),
    name: String(row.name ?? row.code),
    updatedAt: tsIso(row.updated_at ?? row.updatedAt),
  };
  return { ...base, fingerprint: permissionFingerprint(base) };
};

export const mapRoleRow = (row: Record<string, unknown>): PlatformRoleRow => {
  let metadataRaw: unknown = row.metadata;
  if (typeof metadataRaw === 'string') {
    try {
      metadataRaw = JSON.parse(metadataRaw);
    } catch {
      metadataRaw = {};
    }
  }
  const base = {
    createdAt: tsIso(row.created_at ?? row.createdAt),
    description: row.description == null ? '' : String(row.description),
    displayName: String(row.display_name ?? row.displayName ?? row.name),
    id: String(row.id),
    isActive: Boolean(row.is_active ?? row.isActive ?? true),
    isSystem: Boolean(row.is_system ?? row.isSystem ?? true),
    metadata: canonicalizeJson(metadataRaw ?? {}),
    name: String(row.name),
    updatedAt: tsIso(row.updated_at ?? row.updatedAt),
    workspaceId: null as null,
  };
  return { ...base, fingerprint: roleFingerprint(base) };
};
