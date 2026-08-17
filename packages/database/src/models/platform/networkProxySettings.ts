import { and, eq } from 'drizzle-orm';

import type { DesiredArtifacts, NetworkProxyConfig } from '@/types/platform/networkProxy';
import {
  createDefaultNetworkProxyConfig,
  desiredArtifactsSchema,
  normalizeNetworkProxyConfig,
} from '@/types/platform/networkProxy';

import { inTransaction } from '../../repositories/platform/tx';
import {
  PLATFORM_NETWORK_PROXY_SETTINGS_ID,
  platformNetworkProxySettings,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformRevisionConflictError } from './errors';

export { PLATFORM_NETWORK_PROXY_SETTINGS_ID };

export interface PlatformNetworkProxySettingsRow {
  config: NetworkProxyConfig;
  createdAt: Date;
  desiredArtifacts: DesiredArtifacts;
  engineGeneration: number;
  id: string;
  revision: number;
  updatedAt: Date;
  updatedBy: string | null;
}

const normalizeDesiredArtifacts = (raw: unknown): DesiredArtifacts => {
  const parsed = desiredArtifactsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
};

/**
 * Reads and writes the singleton {@link platformNetworkProxySettings} row.
 *
 * Deep-import this file from the runtime hot path — do not pull
 * `models/platform` (the barrel loads ~30 unrelated models).
 */
export class NetworkProxySettingsModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  get = async (): Promise<PlatformNetworkProxySettingsRow | null> => {
    const [row] = await this.db
      .select()
      .from(platformNetworkProxySettings)
      .where(eq(platformNetworkProxySettings.id, PLATFORM_NETWORK_PROXY_SETTINGS_ID))
      .limit(1);

    return row ? this.toRow(row) : null;
  };

  ensureDefault = async (): Promise<PlatformNetworkProxySettingsRow> => {
    const existing = await this.get();
    if (existing) return existing;

    const [inserted] = await this.db
      .insert(platformNetworkProxySettings)
      .values({
        config: createDefaultNetworkProxyConfig(),
        id: PLATFORM_NETWORK_PROXY_SETTINGS_ID,
        revision: 0,
      })
      .onConflictDoNothing({ target: platformNetworkProxySettings.id })
      .returning();

    if (inserted) return this.toRow(inserted);

    const raced = await this.get();
    if (!raced) throw new Error('Failed to ensure default network-proxy settings');
    return raced;
  };

  /**
   * Replace the persisted config with CAS. Every successful write bumps `revision`.
   * @throws PlatformRevisionConflictError when expectedRevision mismatches
   */
  update = async (params: {
    config: NetworkProxyConfig;
    expectedRevision: number;
    updatedBy: string | null;
  }): Promise<PlatformNetworkProxySettingsRow> => {
    return this.write((locked) => ({
      config: params.config,
      desiredArtifacts: locked?.desiredArtifacts ?? {},
      engineGeneration: locked?.engineGeneration ?? 0,
      updatedBy: params.updatedBy,
    }))(params.expectedRevision);
  };

  /**
   * Bump `engine_generation` (and `revision`) so every instance restarts its engine.
   */
  bumpEngineGeneration = async (params: {
    expectedRevision: number;
    updatedBy: string | null;
  }): Promise<PlatformNetworkProxySettingsRow> => {
    return this.write((locked) => ({
      config: locked
        ? normalizeNetworkProxyConfig(locked.config)
        : createDefaultNetworkProxyConfig(),
      desiredArtifacts: locked?.desiredArtifacts ?? {},
      engineGeneration: (locked?.engineGeneration ?? 0) + 1,
      updatedBy: params.updatedBy,
    }))(params.expectedRevision);
  };

  /**
   * Merge `patch` into `desired_artifacts` and bump `revision`.
   */
  setDesiredArtifacts = async (
    patch: DesiredArtifacts,
    params: { expectedRevision: number; updatedBy: string | null },
  ): Promise<PlatformNetworkProxySettingsRow> => {
    return this.write((locked) => ({
      config: locked
        ? normalizeNetworkProxyConfig(locked.config)
        : createDefaultNetworkProxyConfig(),
      desiredArtifacts: {
        ...normalizeDesiredArtifacts(locked?.desiredArtifacts),
        ...patch,
      },
      engineGeneration: locked?.engineGeneration ?? 0,
      updatedBy: params.updatedBy,
    }))(params.expectedRevision);
  };

  private write =
    (
      next: (locked: typeof platformNetworkProxySettings.$inferSelect | undefined) => {
        config: NetworkProxyConfig;
        desiredArtifacts: DesiredArtifacts;
        engineGeneration: number;
        updatedBy: string | null;
      },
    ) =>
    async (expectedRevision: number): Promise<PlatformNetworkProxySettingsRow> => {
      const run = async (db: Transaction) => {
        const [locked] = await db
          .select()
          .from(platformNetworkProxySettings)
          .where(eq(platformNetworkProxySettings.id, PLATFORM_NETWORK_PROXY_SETTINGS_ID))
          .limit(1)
          .for('update');

        const currentRevision = locked?.revision ?? 0;
        if (currentRevision !== expectedRevision) {
          throw new PlatformRevisionConflictError(
            'Network proxy settings revision conflict: expectedRevision does not match current revision',
            {
              currentRevision,
              expectedRevision,
              resourceId: PLATFORM_NETWORK_PROXY_SETTINGS_ID,
              resourceType: 'network_proxy_settings',
            },
          );
        }

        const nextRevision = currentRevision + 1;
        const values = next(locked);

        if (!locked) {
          const [inserted] = await db
            .insert(platformNetworkProxySettings)
            .values({
              config: values.config,
              desiredArtifacts: values.desiredArtifacts,
              engineGeneration: values.engineGeneration,
              id: PLATFORM_NETWORK_PROXY_SETTINGS_ID,
              revision: nextRevision,
              updatedBy: values.updatedBy,
            })
            .onConflictDoNothing({ target: platformNetworkProxySettings.id })
            .returning();
          if (!inserted) {
            throw new PlatformRevisionConflictError(
              'Network proxy settings revision conflict: concurrent first-write',
              {
                expectedRevision,
                resourceId: PLATFORM_NETWORK_PROXY_SETTINGS_ID,
                resourceType: 'network_proxy_settings',
              },
            );
          }
          return this.toRow(inserted);
        }

        const [updated] = await db
          .update(platformNetworkProxySettings)
          .set({
            config: values.config,
            desiredArtifacts: values.desiredArtifacts,
            engineGeneration: values.engineGeneration,
            revision: nextRevision,
            updatedAt: new Date(),
            updatedBy: values.updatedBy,
          })
          .where(
            and(
              eq(platformNetworkProxySettings.id, PLATFORM_NETWORK_PROXY_SETTINGS_ID),
              eq(platformNetworkProxySettings.revision, expectedRevision),
            ),
          )
          .returning();

        if (!updated) {
          throw new PlatformRevisionConflictError(
            'Network proxy settings revision conflict: expectedRevision does not match current revision',
            {
              currentRevision,
              expectedRevision,
              resourceId: PLATFORM_NETWORK_PROXY_SETTINGS_ID,
              resourceType: 'network_proxy_settings',
            },
          );
        }

        return this.toRow(updated);
      };

      return inTransaction(this.db, run);
    };

  private toRow = (
    row: typeof platformNetworkProxySettings.$inferSelect,
  ): PlatformNetworkProxySettingsRow => ({
    config: normalizeNetworkProxyConfig(row.config),
    createdAt: row.createdAt,
    desiredArtifacts: normalizeDesiredArtifacts(row.desiredArtifacts),
    engineGeneration: row.engineGeneration,
    id: row.id,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ?? null,
  });
}
