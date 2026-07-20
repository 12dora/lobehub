import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';

import { MANAGED_RESOURCE_KINDS } from '@/const/platform/managedResources';
import { checksumPayload } from '@/database/models/platform/checksum';
import {
  platformAgents,
  platformAgentVersions,
  platformAiProviders,
  platformBranding,
  platformConnectors,
  platformManagedResourcePolicies,
  platformResourceRevisions,
  platformSettingsBundle,
  platformSkills,
  platformSkillVersions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type {
  PlatformConvergenceDomain,
  PlatformDomainTarget,
  PlatformRevisionToken,
} from '@/server/enterprise/contracts/platformInstanceStatus';
import {
  PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS,
  PLATFORM_CONVERGENCE_DOMAINS,
} from '@/server/enterprise/contracts/platformInstanceStatus';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { loadPublishedIdentityTarget } from '../identityProvider/systemService';
import { getBuiltinSkillDefinitions } from '../skillCatalog/builtinAdapter';
import type { SkillCatalogBuiltinTokenEntry } from './catalogTokens';
import {
  buildAiCatalogRevisionToken,
  buildSkillCatalogRevisionToken,
  PlatformCatalogTokenInvariantError,
} from './catalogTokens';

type DomainEnabled = (flags: ReturnType<typeof parseEnterpriseFeatureFlags>) => boolean;

const DOMAIN_ENABLED = {
  agent_catalog: (flags) => flags.ENABLE_PLATFORM_MANAGED_AGENTS,
  ai_catalog: (flags) => flags.ENABLE_PLATFORM_MANAGED_AI,
  branding: (flags) => flags.ENABLE_RUNTIME_BRANDING,
  connector_catalog: (flags) => flags.ENABLE_PLATFORM_MANAGED_CONNECTORS,
  identity: (flags) => flags.ENABLE_DATABASE_OIDC,
  managed_policy: (flags) =>
    flags.ENABLE_PLATFORM_MANAGED_AGENTS ||
    flags.ENABLE_PLATFORM_MANAGED_AI ||
    flags.ENABLE_PLATFORM_MANAGED_CONNECTORS ||
    flags.ENABLE_PLATFORM_MANAGED_SKILLS,
  settings: (flags) => flags.ENABLE_PLATFORM_SETTINGS_POLICY,
  skill_catalog: (flags) => flags.ENABLE_PLATFORM_MANAGED_SKILLS,
} as const satisfies Record<PlatformConvergenceDomain, DomainEnabled>;

class PlatformDomainTargetInvariantError extends Error {
  constructor() {
    super('PLATFORM_DOMAIN_TARGET_INVARIANT');
    this.name = 'PlatformDomainTargetInvariantError';
  }
}

const immutableToken = (value: unknown): PlatformRevisionToken => ({
  kind: 'immutable_id',
  value: checksumPayload(value),
});

const revisionToken = (value: number): PlatformRevisionToken => ({ kind: 'revision', value });

const isChecksum = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

type IdentityTargetLoader = typeof loadPublishedIdentityTarget;
type SkillBuiltinTokenLoader = () => SkillCatalogBuiltinTokenEntry[];

export interface PlatformDomainTargetResolverOptions {
  env?: Record<string, string | undefined>;
  loadBuiltinSkillTokenEntries?: SkillBuiltinTokenLoader;
  loadIdentityTarget?: IdentityTargetLoader;
}

/** Resolves only normalized, authoritative current pointers; immutable history is never scanned. */
export class PlatformDomainTargetResolver {
  private readonly env: Record<string, string | undefined>;
  private readonly flags: ReturnType<typeof parseEnterpriseFeatureFlags>;
  private readonly loadBuiltinSkillTokenEntries: SkillBuiltinTokenLoader;
  private readonly loadIdentityTarget: IdentityTargetLoader;

  constructor(
    private readonly db: LobeChatDatabase | Transaction,
    options: PlatformDomainTargetResolverOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.flags = parseEnterpriseFeatureFlags(this.env);
    this.loadBuiltinSkillTokenEntries =
      options.loadBuiltinSkillTokenEntries ??
      (() =>
        getBuiltinSkillDefinitions().map(({ checksum, skillKey, version }) => ({
          checksum,
          skillKey,
          version,
        })));
    this.loadIdentityTarget = options.loadIdentityTarget ?? loadPublishedIdentityTarget;
  }

  private available = (
    domain: PlatformConvergenceDomain,
    token: PlatformRevisionToken | null,
  ): PlatformDomainTarget => ({
    domain,
    errorCategory: null,
    fallbackPolicy: PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[domain].fallbackPolicy,
    loadMode: PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[domain].loadMode,
    status: 'available',
    token,
  });

  private disabled = (domain: PlatformConvergenceDomain): PlatformDomainTarget => ({
    domain,
    errorCategory: null,
    fallbackPolicy: PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[domain].fallbackPolicy,
    loadMode: PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[domain].loadMode,
    status: 'disabled',
    token: null,
  });

  private unavailable = (
    domain: PlatformConvergenceDomain,
    configurationInvalid: boolean,
  ): PlatformDomainTarget => ({
    domain,
    errorCategory: configurationInvalid ? 'configuration_invalid' : 'database_unavailable',
    fallbackPolicy: PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[domain].fallbackPolicy,
    loadMode: PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[domain].loadMode,
    status: 'unavailable',
    token: null,
  });

  private resolveSettings = async (): Promise<PlatformRevisionToken> => {
    const [bundle] = await this.db
      .select({ revision: platformSettingsBundle.revision, status: platformSettingsBundle.status })
      .from(platformSettingsBundle)
      .where(eq(platformSettingsBundle.id, 'global'))
      .limit(1);
    if (!bundle) return revisionToken(0);
    if (bundle.revision < 0 || (bundle.revision > 0 && bundle.status !== 'published')) {
      throw new PlatformDomainTargetInvariantError();
    }
    return revisionToken(bundle.revision);
  };

  private resolveAiCatalog = async (): Promise<PlatformRevisionToken> => {
    const rows = await this.db
      .select({
        checksum: platformResourceRevisions.checksum,
        providerId: platformAiProviders.id,
        providerKey: platformAiProviders.providerKey,
        revision: platformAiProviders.revision,
        secretFingerprint: platformResourceRevisions.secretFingerprint,
      })
      .from(platformAiProviders)
      .leftJoin(
        platformResourceRevisions,
        and(
          eq(platformResourceRevisions.resourceType, 'provider'),
          eq(platformResourceRevisions.resourceId, platformAiProviders.id),
          eq(platformResourceRevisions.revision, platformAiProviders.revision),
          eq(platformResourceRevisions.status, 'published'),
        ),
      )
      .where(eq(platformAiProviders.status, 'published'))
      .orderBy(asc(platformAiProviders.providerKey), asc(platformAiProviders.id));
    return buildAiCatalogRevisionToken(rows);
  };

  private resolveSkillCatalog = async (): Promise<PlatformRevisionToken> => {
    const snapshotAllowBuiltinOverride = sql<boolean>`COALESCE((${platformResourceRevisions.payload}->'skill'->>'allowBuiltinOverride')::boolean, false)`;
    const snapshotBuiltinOverrideTombstone = sql<boolean>`COALESCE((${platformResourceRevisions.payload}->>'builtinOverrideTombstone')::boolean, false)`;
    const snapshotEnabled = sql<boolean>`COALESCE((${platformResourceRevisions.payload}->'skill'->>'enabled')::boolean, false)`;
    const snapshotSkillKey = sql<string>`${platformResourceRevisions.payload}->'skill'->>'skillKey'`;
    const rows = await this.db
      .select({
        allowBuiltinOverride: snapshotAllowBuiltinOverride,
        builtinOverrideTombstone: snapshotBuiltinOverrideTombstone,
        checksum: platformSkillVersions.checksum,
        currentVersionId: platformSkillVersions.id,
        enabled: snapshotEnabled,
        revision: platformResourceRevisions.revision,
        skillId: platformSkills.id,
        skillKey: snapshotSkillKey,
        status: platformResourceRevisions.status,
      })
      .from(platformSkills)
      .leftJoin(
        platformResourceRevisions,
        and(
          eq(platformResourceRevisions.resourceType, 'skill'),
          eq(platformResourceRevisions.resourceId, platformSkills.id),
          eq(platformResourceRevisions.revision, platformSkills.revision),
        ),
      )
      .leftJoin(
        platformSkillVersions,
        and(
          eq(platformSkillVersions.skillId, platformSkills.id),
          eq(
            platformSkillVersions.id,
            sql<string>`${platformResourceRevisions.payload}->>'versionId'`,
          ),
        ),
      )
      .where(gt(platformSkills.revision, 0))
      .orderBy(asc(snapshotSkillKey), asc(platformSkills.id));
    return buildSkillCatalogRevisionToken({
      builtins: this.loadBuiltinSkillTokenEntries(),
      platform: rows.flatMap((row) => {
        if (row.revision === null) {
          return [
            {
              checksum: null,
              currentVersionId: null,
              revision: 0,
              skillId: row.skillId,
              skillKey: row.skillKey,
              tombstone: false,
            },
          ];
        }
        const tombstone =
          row.status === 'archived' && row.allowBuiltinOverride && row.builtinOverrideTombstone;
        if (!row.enabled || (row.status !== 'published' && !tombstone)) return [];
        return [
          {
            checksum: row.checksum,
            currentVersionId: row.currentVersionId,
            revision: row.revision,
            skillId: row.skillId,
            skillKey: row.skillKey,
            tombstone,
          },
        ];
      }),
    });
  };

  private resolveConnectorCatalog = async (): Promise<PlatformRevisionToken> => {
    const rows = await this.db
      .select({
        checksum: platformResourceRevisions.checksum,
        connectorId: platformConnectors.id,
        connectorKey: platformConnectors.connectorKey,
        revision: platformConnectors.publishedRevision,
      })
      .from(platformConnectors)
      .leftJoin(
        platformResourceRevisions,
        and(
          eq(platformResourceRevisions.resourceType, 'connector'),
          eq(platformResourceRevisions.resourceId, platformConnectors.id),
          eq(platformResourceRevisions.revision, platformConnectors.publishedRevision),
          eq(platformResourceRevisions.checksum, platformConnectors.publishedChecksum),
          eq(platformResourceRevisions.status, 'published'),
        ),
      )
      .where(
        and(
          eq(platformConnectors.migrationRequired, false),
          eq(platformConnectors.enabled, true),
          eq(platformConnectors.status, 'published'),
        ),
      )
      .orderBy(asc(platformConnectors.connectorKey), asc(platformConnectors.id));
    if (
      rows.some(({ checksum, revision }) => !revision || revision <= 0 || !isChecksum(checksum))
    ) {
      throw new PlatformDomainTargetInvariantError();
    }
    return immutableToken(rows);
  };

  private resolveAgentCatalog = async (): Promise<PlatformRevisionToken> => {
    const rows = await this.db
      .select({
        agentId: platformAgents.id,
        agentKey: platformAgents.agentKey,
        checksum: platformAgentVersions.checksum,
        currentVersionId: platformAgents.currentVersionId,
        revision: platformAgents.revision,
      })
      .from(platformAgents)
      .leftJoin(
        platformAgentVersions,
        and(
          eq(platformAgentVersions.agentId, platformAgents.id),
          eq(platformAgentVersions.id, platformAgents.currentVersionId),
        ),
      )
      .where(
        and(eq(platformAgents.migrationRequired, false), eq(platformAgents.status, 'published')),
      )
      .orderBy(asc(platformAgents.agentKey), asc(platformAgents.id));
    if (
      rows.some(
        ({ checksum, currentVersionId, revision }) =>
          revision <= 0 || !currentVersionId || !isChecksum(checksum),
      )
    ) {
      throw new PlatformDomainTargetInvariantError();
    }
    return immutableToken(rows);
  };

  private resolveIdentity = async (): Promise<PlatformRevisionToken | null> => {
    const target = await this.loadIdentityTarget(this.db, this.env);
    if (target.identityRevision === null) return null;
    if (!isChecksum(target.identityRevision)) throw new PlatformDomainTargetInvariantError();
    return { kind: 'immutable_id', value: target.identityRevision };
  };

  private resolveBranding = async (): Promise<PlatformRevisionToken> => {
    const rows = await this.db
      .select({ revision: platformBranding.revision })
      .from(platformBranding)
      .where(eq(platformBranding.status, 'published'))
      .orderBy(asc(platformBranding.id))
      .limit(2);
    if (rows.length !== 1 || (rows[0]?.revision ?? 0) <= 0) {
      throw new PlatformDomainTargetInvariantError();
    }
    return revisionToken(rows[0]!.revision);
  };

  private resolveManagedPolicy = async (): Promise<PlatformRevisionToken> => {
    const rows = await this.db
      .select({
        resource: platformManagedResourcePolicies.resource,
        revision: platformManagedResourcePolicies.revision,
        status: platformManagedResourcePolicies.status,
      })
      .from(platformManagedResourcePolicies)
      .where(inArray(platformManagedResourcePolicies.resource, [...MANAGED_RESOURCE_KINDS]))
      .orderBy(asc(platformManagedResourcePolicies.resource));
    const resources = new Set(rows.map(({ resource }) => resource));
    const revisions = new Set(rows.map(({ revision }) => revision));
    if (
      rows.length !== MANAGED_RESOURCE_KINDS.length ||
      resources.size !== MANAGED_RESOURCE_KINDS.length ||
      revisions.size !== 1 ||
      rows.some(({ revision, status }) => revision <= 0 || status !== 'published')
    ) {
      throw new PlatformDomainTargetInvariantError();
    }
    return revisionToken(rows[0]!.revision);
  };

  private resolveToken = (
    domain: PlatformConvergenceDomain,
  ): Promise<PlatformRevisionToken | null> => {
    switch (domain) {
      case 'agent_catalog': {
        return this.resolveAgentCatalog();
      }
      case 'ai_catalog': {
        return this.resolveAiCatalog();
      }
      case 'branding': {
        return this.resolveBranding();
      }
      case 'connector_catalog': {
        return this.resolveConnectorCatalog();
      }
      case 'identity': {
        return this.resolveIdentity();
      }
      case 'managed_policy': {
        return this.resolveManagedPolicy();
      }
      case 'settings': {
        return this.resolveSettings();
      }
      case 'skill_catalog': {
        return this.resolveSkillCatalog();
      }
    }
  };

  resolve = async (domain: PlatformConvergenceDomain): Promise<PlatformDomainTarget> => {
    if (!DOMAIN_ENABLED[domain](this.flags)) return this.disabled(domain);
    try {
      return this.available(domain, await this.resolveToken(domain));
    } catch (error) {
      return this.unavailable(
        domain,
        error instanceof PlatformDomainTargetInvariantError ||
          error instanceof PlatformCatalogTokenInvariantError,
      );
    }
  };

  resolveAll = async (): Promise<PlatformDomainTarget[]> =>
    Promise.all(PLATFORM_CONVERGENCE_DOMAINS.map((domain) => this.resolve(domain)));
}
