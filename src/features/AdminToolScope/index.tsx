'use client';

import type { SkillListItem, SkillResourceTreeNode } from '@lobechat/types';
import type { ReactNode } from 'react';
import { createContext, use } from 'react';

import type { ConnectorToolPermission } from '@/database/schemas';
import type { ConnectorWithTools } from '@/store/tool/slices/connector/types';

export type AdminSkillDistribution = 'default' | 'mandatory' | 'optional';

/** Data shape AgentSkillDetail renders (mirrors useFetchAgentSkillDetail result). */
export interface AdminOrgSkillDetailData {
  resourceTree?: SkillResourceTreeNode[];
  skillDetail?: {
    content?: string | null;
    description?: string | null;
    manifest?: Record<string, any> | null;
    name: string;
    updatedAt: string | number | Date;
  };
}

/**
 * Org-global datasource injected by the admin panel so the user-facing
 * skill/connector settings UI renders unchanged while every read/write targets
 * the platform catalog (admin.skills / admin.connectors) instead of the
 * signed-in user's rows.
 *
 * When this context is absent (all ordinary user surfaces) every consumer
 * falls back to the existing tool-store selectors/actions — user behavior is
 * untouched by construction.
 */
export interface AdminToolScope {
  /** Extra warning/notice rendered above both settings views (e.g. per-user OAuth caveat). */
  connectorNotice?: ReactNode;
  /** Platform connectors + synthesized builtin rows, in ConnectorWithTools shape. */
  connectors: ConnectorWithTools[];
  /** Remove a platform connector org-wide (archive). */
  deleteConnector: (connectorId: string) => Promise<void>;
  /** Remove an org catalog skill (archive). */
  deleteOrgSkill: (skillId: string) => Promise<void>;
  getBuiltinSkillDistribution: (identifier: string) => AdminSkillDistribution;
  /** Create an org skill from a GitHub repository (server-side parse + publish). */
  importFromGithub: (repoUrl: string) => Promise<void>;
  /** Create an org skill from a URL (server-side parse + publish). */
  importFromUrl: (url: string) => Promise<void>;
  /** Create an org skill from an uploaded ZIP (server-side parse + publish). */
  importFromZip: (file: File) => Promise<void>;
  /** Install a marketplace skill into the org catalog (skill-store parity). */
  installFromMarket: (identifier: string) => Promise<void>;
  /** Builtin skill (Artifacts, LobeHub…) org-wide availability. */
  isBuiltinSkillEnabled: (identifier: string) => boolean;
  /**
   * Builtin in-process tools have no org-wide policy backend; their permission
   * editor renders read-only in the admin scope.
   */
  isConnectorReadOnly: (connector: ConnectorWithTools) => boolean;
  listError?: unknown;
  listLoading: boolean;
  /** Org catalog skills mapped into the user SkillListItem shape (custom skills section). */
  orgSkills: SkillListItem[];
  resetConnectorPermissions: (connectorId: string) => Promise<void>;
  retry: () => void;
  setBuiltinSkillDistribution: (
    identifier: string,
    distribution: AdminSkillDistribution,
  ) => Promise<void>;
  /** CustomConnectorModal submit → platform connector applyImmediate. */
  submitCustomConnector: (values: {
    auth?: { clientId?: string; clientSecret?: string; token?: string; type?: string };
    identifier: string;
    serverUrl?: string;
    transport: 'http' | 'stdio';
  }) => Promise<void>;
  toggleBuiltinSkill: (identifier: string, enabled: boolean) => Promise<void>;
  updateToolPermission: (toolId: string, permission: ConnectorToolPermission) => Promise<void>;
  /** Detail data for an org catalog skill (AgentSkillDetail parity). */
  useOrgSkillDetail: (skillId: string) => {
    data?: AdminOrgSkillDetailData;
    isLoading: boolean;
  };
}

const AdminToolScopeContext = createContext<AdminToolScope | null>(null);

export const AdminToolScopeProvider = AdminToolScopeContext.Provider;

/** Null on every ordinary user surface; non-null only under the admin panel. */
export const useAdminToolScope = (): AdminToolScope | null => use(AdminToolScopeContext);
