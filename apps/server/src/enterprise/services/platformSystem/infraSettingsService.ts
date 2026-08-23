import { getServerDB } from '@/database/core/db-adaptor';
import type {
  AdminSystemGetInfraSettings,
  AdminSystemInfraDependency,
  AdminSystemMailConfig,
  AdminSystemObjectStorageConfig,
} from '@/server/enterprise/contracts/adminSystem';

import {
  envPreviewUrlExpireIn,
  getInfraSnapshot,
  getMailSettings,
  getObjectStorageSettings,
  mailSnapshotToEnvBag,
  objectStorageSnapshotToEnvBag,
  resolveInfraEnvBag,
} from '../infraSettings';
import {
  assertMailDestinationsAllowed,
  assertObjectStorageDestinationsAllowed,
  InfraSettingsDestinationError,
} from '../infraSettings/destinationPolicy';
import {
  InfraSettingsSecretRequiredError,
  InfraSettingsSecretReuseError,
} from '../infraSettings/errors';
import { maskAccessId, parseFromField } from './infraDependencyConfig';
import type { InfraProbeReason, InfraS3Client } from './infraProbes';
import { defaultCreateS3Client, InfraProbeError, probeObjectStorage } from './infraProbes';
import { envBagFromDraft } from './infraSettingsDraftEnv';
import {
  defaultCreateMailTransport,
  defaultOutboundFetch,
  probeMail,
} from './infraSettingsMailProbe';
import { projectInfraSettingsFromEnv } from './infraSettingsProjection';
import type { EnvBag, InfraSettingsServiceOptions } from './infraSettingsTypes';

export type { InfraProbeReason, InfraS3Client };
export type {
  InfraMailTransport,
  InfraOutboundFetch,
  InfraSettingsServiceOptions,
} from './infraSettingsTypes';
export { InfraProbeError };

const resolveEnv = (override?: EnvBag): EnvBag => resolveInfraEnvBag(override);

export class InfraSettingsService {
  private readonly createMailTransport: NonNullable<
    InfraSettingsServiceOptions['createMailTransport']
  >;
  private readonly assertMailDestinations: typeof assertMailDestinationsAllowed;
  private readonly assertObjectStorageDestinations: typeof assertObjectStorageDestinationsAllowed;
  private readonly createS3Client: NonNullable<InfraSettingsServiceOptions['createS3Client']>;
  private readonly env: EnvBag;
  private readonly envOverride: boolean;
  private readonly now: () => Date;
  private readonly outboundFetch: NonNullable<InfraSettingsServiceOptions['outboundFetch']>;

  constructor(options: InfraSettingsServiceOptions = {}) {
    this.envOverride = options.env !== undefined;
    this.env = resolveEnv(options.env);
    this.now = options.now ?? (() => new Date());
    this.createS3Client = options.createS3Client ?? defaultCreateS3Client;
    this.createMailTransport = options.createMailTransport ?? defaultCreateMailTransport;
    this.outboundFetch = options.outboundFetch ?? defaultOutboundFetch;
    this.assertObjectStorageDestinations =
      options.assertObjectStorageDestinations ?? assertObjectStorageDestinationsAllowed;
    this.assertMailDestinations = options.assertMailDestinations ?? assertMailDestinationsAllowed;
  }

  getInfraSettings = async (): Promise<AdminSystemGetInfraSettings> => {
    if (this.envOverride) {
      return projectInfraSettingsFromEnv(
        this.env,
        {
          mail: {
            enabled: false,
            hasResendApiKey: Boolean(this.env.RESEND_API_KEY),
            hasSmtpPass: Boolean(this.env.SMTP_PASS),
            revision: 0,
            smtpUser: this.env.SMTP_USER?.trim() || null,
            source: 'env',
          },
          objectStorage: {
            accessIdMode: 'mask',
            enabled: false,
            hasSecretAccessKey: Boolean(this.env.S3_SECRET_ACCESS_KEY),
            previewUrlExpireIn: envPreviewUrlExpireIn(this.env),
            revision: 0,
            setAcl: this.env.S3_SET_ACL === '1',
            source: 'env',
          },
        },
        this.now(),
      );
    }

    const db = await getServerDB();
    const [snapshot, storageRow, mailRow] = await Promise.all([
      getInfraSnapshot(),
      getObjectStorageSettings(db),
      getMailSettings(db),
    ]);
    const storageBag = objectStorageSnapshotToEnvBag(snapshot.objectStorage);
    const mailBag = mailSnapshotToEnvBag(snapshot.mail);
    const merged: EnvBag = { ...this.env, ...storageBag, ...mailBag };

    return projectInfraSettingsFromEnv(
      merged,
      {
        mail: {
          enabled: mailRow.config.enabled,
          hasResendApiKey:
            snapshot.mail.source === 'db'
              ? Boolean(mailRow.config.resend?.apiKeyCiphertext)
              : Boolean(this.env.RESEND_API_KEY),
          hasSmtpPass:
            snapshot.mail.source === 'db'
              ? Boolean(mailRow.config.smtp?.passCiphertext)
              : Boolean(this.env.SMTP_PASS),
          revision: mailRow.revision,
          // Per-card all-or-nothing: the read view never mixes stored (db) values into an
          // env-sourced card, otherwise a reverted override would keep showing its old user.
          smtpUser:
            snapshot.mail.kind === 'smtp'
              ? snapshot.mail.user
              : (snapshot.mail.source === 'db'
                  ? mailRow.config.smtp?.user
                  : this.env.SMTP_USER?.trim()) || null,
          source: snapshot.mail.source,
        },
        objectStorage: {
          accessIdMode: snapshot.objectStorage.source === 'db' ? 'full' : 'mask',
          enabled: storageRow.config.enabled,
          hasSecretAccessKey:
            snapshot.objectStorage.source === 'db'
              ? Boolean(storageRow.config.secretAccessKeyCiphertext)
              : Boolean(this.env.S3_SECRET_ACCESS_KEY),
          previewUrlExpireIn: snapshot.objectStorage.previewUrlExpireIn,
          revision: storageRow.revision,
          setAcl:
            snapshot.objectStorage.kind === 'complete'
              ? snapshot.objectStorage.setAcl
              : storageRow.config.setAcl,
          source: snapshot.objectStorage.source,
        },
      },
      this.now(),
    );
  };

  testDependency = async (input: {
    dependency: Exclude<AdminSystemInfraDependency, 'documentRender'>;
    draft?: AdminSystemMailConfig | AdminSystemObjectStorageConfig;
  }): Promise<{
    checkedAt: Date;
    latencyMs: number;
    message?: InfraProbeReason;
    ok: boolean;
  }> => {
    const started = Date.now();
    const checkedAt = this.now();
    try {
      const draftBag = input.draft
        ? await envBagFromDraft(input.dependency, input.draft, {
            env: this.env,
            envOverride: this.envOverride,
          })
        : null;
      if (draftBag === 'configuration_incomplete') {
        throw new InfraProbeError('configuration_incomplete');
      }
      const env = draftBag ?? (await this.effectiveEnvFor(input.dependency));

      if (input.dependency === 'objectStorage') {
        if (input.draft) {
          await this.assertObjectStorageDestinations(input.draft as AdminSystemObjectStorageConfig);
        }
        await probeObjectStorage(env, this.createS3Client);
      } else {
        if (input.draft) {
          await this.assertMailDestinations(input.draft as AdminSystemMailConfig);
        }
        await probeMail(env, {
          createMailTransport: this.createMailTransport,
          outboundFetch: this.outboundFetch,
        });
      }
      return { checkedAt, latencyMs: Date.now() - started, ok: true };
    } catch (error) {
      if (
        error instanceof InfraSettingsSecretReuseError ||
        error instanceof InfraSettingsSecretRequiredError ||
        error instanceof InfraSettingsDestinationError
      ) {
        throw error;
      }
      const reason = error instanceof InfraProbeError ? error.reason : 'unreachable';
      return {
        checkedAt,
        latencyMs: Date.now() - started,
        message: reason,
        ok: false,
      };
    }
  };

  private effectiveEnvFor = async (dependency: 'mail' | 'objectStorage'): Promise<EnvBag> => {
    if (this.envOverride) return this.env;
    const snapshot = await getInfraSnapshot();
    if (dependency === 'objectStorage') {
      return { ...this.env, ...objectStorageSnapshotToEnvBag(snapshot.objectStorage) };
    }
    return { ...this.env, ...mailSnapshotToEnvBag(snapshot.mail) };
  };
}

export { maskAccessId, parseFromField };
