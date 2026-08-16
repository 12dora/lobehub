/**
 * Effective FileS3 constructor inputs.
 *
 * Mirrors `S3` / `FileS3`: access key, secret, endpoint, and bucket are required.
 * Region defaults to `us-east-1`. Changing this must keep FileS3 behaviour identical.
 */
export const DEFAULT_S3_REGION = 'us-east-1';

export interface FileS3ConfigSource {
  S3_ACCESS_KEY_ID?: string;
  S3_BUCKET?: string;
  S3_ENABLE_PATH_STYLE?: boolean | string;
  S3_ENDPOINT?: string;
  S3_PUBLIC_DOMAIN?: string;
  S3_REGION?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_SET_ACL?: boolean | string;
}

export type ResolvedFileS3Config =
  | { kind: 'incomplete' }
  | { kind: 'unconfigured' }
  | {
      accessKeyId: string;
      bucket: string;
      endpoint: string;
      forcePathStyle: boolean;
      kind: 'complete';
      publicDomain: string | undefined;
      region: string;
      secretAccessKey: string;
      setAcl: boolean;
    };

const trim = (value: string | undefined): string | undefined => {
  const next = value?.trim();
  return next || undefined;
};

const readFlag = (value: boolean | string | undefined): boolean =>
  value === true || value === '1' || value === 'true';

export const resolveFileS3Config = (env: FileS3ConfigSource): ResolvedFileS3Config => {
  const accessKeyId = trim(env.S3_ACCESS_KEY_ID);
  const secretAccessKey = trim(env.S3_SECRET_ACCESS_KEY);
  const endpoint = trim(env.S3_ENDPOINT);
  const bucket = trim(env.S3_BUCKET);
  const publicDomain = trim(env.S3_PUBLIC_DOMAIN);
  const configuredRegion = trim(env.S3_REGION);
  const anyConfigured = Boolean(
    accessKeyId || secretAccessKey || endpoint || bucket || publicDomain || configuredRegion,
  );
  if (!anyConfigured) return { kind: 'unconfigured' };
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return { kind: 'incomplete' };
  return {
    accessKeyId,
    bucket,
    endpoint,
    forcePathStyle: readFlag(env.S3_ENABLE_PATH_STYLE),
    kind: 'complete',
    publicDomain,
    region: configuredRegion ?? DEFAULT_S3_REGION,
    secretAccessKey,
    setAcl: readFlag(env.S3_SET_ACL),
  };
};
