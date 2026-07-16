import { eq, inArray, sql } from 'drizzle-orm';

import {
  MANAGED_RESOURCE_KINDS,
  type ManagedResourceKind,
} from '@/const/platform/managedResources';
import type {
  ManagedResourcePolicyItem,
  ManagedResourcePolicyMap,
  PlatformManagedResourcePolicyConfig,
} from '@/types/platform/managedResources';

import {
  platformManagedResourcePolicies,
  type PlatformManagedResourcePolicyItem,
  type PlatformRevisionStatus,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import type { ResourcePointerAdapter } from './revision';

const unmanagedItem = (): ManagedResourcePolicyItem => ({
  enforcementMode: 'observe',
  managed: false,
});

export const createUnmanagedResourcePolicyMap = (): ManagedResourcePolicyMap => ({
  agents: unmanagedItem(),
  aiModels: unmanagedItem(),
  aiProviders: unmanagedItem(),
  connectors: unmanagedItem(),
  skills: unmanagedItem(),
});

const createInitialConfig = (): PlatformManagedResourcePolicyConfig => ({
  draft: unmanagedItem(),
  published: unmanagedItem(),
});

const normalizeItem = (value: ManagedResourcePolicyItem | undefined): ManagedResourcePolicyItem => {
  if (!value || typeof value.managed !== 'boolean') return unmanagedItem();
  if (!['observe', 'ui-only', 'enforced'].includes(value.enforcementMode)) return unmanagedItem();
  return { enforcementMode: value.enforcementMode, managed: value.managed };
};

export interface ManagedResourcePolicySnapshot {
  draft: ManagedResourcePolicyMap;
  published: ManagedResourcePolicyMap;
  revision: number;
  status: 'draft' | 'published';
}

/** Aggregate repository over the five fixed rows created by M01. */
export class PlatformManagedResourcePolicyModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  ensureRows = async (): Promise<void> => {
    await this.db
      .insert(platformManagedResourcePolicies)
      .values(
        MANAGED_RESOURCE_KINDS.map((resource) => ({
          config: createInitialConfig(),
          enforcement: 'observe' as const,
          resource,
          revision: 0,
          status: 'draft' as const,
        })),
      )
      .onConflictDoNothing({ target: platformManagedResourcePolicies.resource });
  };

  listRows = async (): Promise<PlatformManagedResourcePolicyItem[]> =>
    this.db
      .select()
      .from(platformManagedResourcePolicies)
      .where(inArray(platformManagedResourcePolicies.resource, [...MANAGED_RESOURCE_KINDS]));

  getSnapshot = async (): Promise<ManagedResourcePolicySnapshot> => {
    const rows = await this.listRows();
    const draft = createUnmanagedResourcePolicyMap();
    const published = createUnmanagedResourcePolicyMap();
    const revisions = new Set<number>();
    let allPublished = rows.length === MANAGED_RESOURCE_KINDS.length;

    for (const row of rows) {
      if (!MANAGED_RESOURCE_KINDS.includes(row.resource as ManagedResourceKind)) continue;
      const resource = row.resource as ManagedResourceKind;
      draft[resource] = normalizeItem(row.config?.draft);
      published[resource] = normalizeItem(row.config?.published);
      revisions.add(row.revision);
      allPublished &&= row.status === 'published';
    }

    const revision = revisions.size === 1 ? ([...revisions][0] ?? 0) : 0;

    return {
      draft,
      published,
      revision,
      status: allPublished && revisions.size === 1 ? 'published' : 'draft',
    };
  };

  /** All rows share one aggregate revision and are locked in deterministic order. */
  lockAndGetRevision = async (): Promise<number> => {
    const result = await this.db.execute(sql`
      SELECT "revision"
      FROM "platform_managed_resource_policies"
      WHERE "resource" IN ('agents', 'aiModels', 'aiProviders', 'connectors', 'skills')
      ORDER BY "resource"
      FOR UPDATE
    `);
    const rows =
      (result as unknown as { rows?: { revision: number }[] }).rows ??
      (result as unknown as { revision: number }[]);
    const revisions = Array.isArray(rows) ? rows.map((row) => Number(row.revision)) : [];
    if (revisions.length !== MANAGED_RESOURCE_KINDS.length) {
      throw new Error('Managed resource policy rows are incomplete');
    }
    const unique = new Set(revisions);
    if (unique.size !== 1) throw new Error('Managed resource policy revision pointers diverged');
    return revisions[0] ?? 0;
  };

  replaceDraft = async (params: {
    draft: ManagedResourcePolicyMap;
    updatedBy?: string | null;
  }): Promise<void> => {
    const now = new Date();
    for (const resource of MANAGED_RESOURCE_KINDS) {
      const [row] = await this.db
        .select({ config: platformManagedResourcePolicies.config })
        .from(platformManagedResourcePolicies)
        .where(eq(platformManagedResourcePolicies.resource, resource))
        .limit(1);
      if (!row) throw new Error(`Managed resource policy row missing: ${resource}`);
      const item = params.draft[resource];
      await this.db
        .update(platformManagedResourcePolicies)
        .set({
          config: { draft: item, published: normalizeItem(row.config?.published) },
          // Compatibility column mirrors effective published state, never mutable draft.
          enforcement: normalizeItem(row.config?.published).enforcementMode,
          updatedAt: now,
          updatedBy: params.updatedBy ?? null,
        })
        .where(eq(platformManagedResourcePolicies.resource, resource));
    }
  };

  updatePointer = async (revision: number, status: PlatformRevisionStatus): Promise<void> => {
    await this.db
      .update(platformManagedResourcePolicies)
      .set({
        revision,
        status: status === 'published' ? 'published' : 'archived',
        updatedAt: new Date(),
      })
      .where(inArray(platformManagedResourcePolicies.resource, [...MANAGED_RESOURCE_KINDS]));
  };

  materializePublished = async (params: {
    policies: ManagedResourcePolicyMap;
    revision: number;
    updatedBy?: string | null;
  }): Promise<void> => {
    const now = new Date();
    for (const resource of MANAGED_RESOURCE_KINDS) {
      const item = params.policies[resource];
      await this.db
        .update(platformManagedResourcePolicies)
        .set({
          config: { draft: item, published: item },
          enforcement: item.enforcementMode,
          revision: params.revision,
          status: 'published',
          updatedAt: now,
          updatedBy: params.updatedBy ?? null,
        })
        .where(eq(platformManagedResourcePolicies.resource, resource));
    }
  };
}

export const createManagedResourcePolicyPointerAdapter = (params: {
  afterMaterialization?: () => Promise<void>;
  assertLockedState?: ResourcePointerAdapter['assertLockedState'];
  prepareLockedPublish?: ResourcePointerAdapter['prepareLockedPublish'];
  updatedBy?: string | null;
}): ResourcePointerAdapter => ({
  assertLockedState: params.assertLockedState,
  lockAndGetRevision: async (tx) => new PlatformManagedResourcePolicyModel(tx).lockAndGetRevision(),
  materializePublished: async (tx, args) => {
    const policies = (args.payload as { policies: ManagedResourcePolicyMap }).policies;
    await new PlatformManagedResourcePolicyModel(tx).materializePublished({
      policies,
      revision: args.revision,
      updatedBy: params.updatedBy,
    });
    await params.afterMaterialization?.();
  },
  prepareLockedPublish: params.prepareLockedPublish,
  updatePointer: async (tx, args) =>
    new PlatformManagedResourcePolicyModel(tx).updatePointer(args.revision, args.status),
});

/** Feature-flag hard gate used by runtime policy resolution. */
export const isManagedResourceFeatureEnabled = (
  resource: ManagedResourceKind,
  flags: {
    ENABLE_PLATFORM_MANAGED_AGENTS: boolean;
    ENABLE_PLATFORM_MANAGED_AI: boolean;
    ENABLE_PLATFORM_MANAGED_CONNECTORS: boolean;
    ENABLE_PLATFORM_MANAGED_SKILLS: boolean;
  },
): boolean => {
  if (resource === 'agents') return flags.ENABLE_PLATFORM_MANAGED_AGENTS;
  if (resource === 'aiModels' || resource === 'aiProviders') {
    return flags.ENABLE_PLATFORM_MANAGED_AI;
  }
  if (resource === 'connectors') return flags.ENABLE_PLATFORM_MANAGED_CONNECTORS;
  if (resource === 'skills') return flags.ENABLE_PLATFORM_MANAGED_SKILLS;
  return false;
};
