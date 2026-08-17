import { INFRA_SETTINGS_DEFAULT_PREVIEW_URL_EXPIRE_IN } from '@/const/platform/infraSettings';

export const INFRA_SECRET_REUSE_MESSAGE =
  'The secret must be re-entered after changing the destination';

export interface ObjectStorageDestinationTuple {
  bucket: string;
  endpoint: string;
  region: string;
}

export interface MailDestinationTuple {
  host: string;
  port: string;
  provider: string;
  secure: string;
  user: string;
}

const trim = (value: string | undefined | null): string => value?.trim() ?? '';

export const synthesizeAwsEndpoint = (region: string): string =>
  `https://s3.${region.trim()}.amazonaws.com`;

/** Canonical endpoint for tuple comparison (strip trailing slash; lowercase host). */
export const canonicalizeEndpoint = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
};

export const objectStorageDestinationTuple = (input: {
  bucket?: string | null;
  endpoint?: string | null;
  region?: string | null;
}): ObjectStorageDestinationTuple => {
  const region = trim(input.region).toLowerCase();
  const endpointRaw = trim(input.endpoint) || (region ? synthesizeAwsEndpoint(region) : '');
  return {
    bucket: trim(input.bucket),
    endpoint: canonicalizeEndpoint(endpointRaw),
    region,
  };
};

export const objectStorageTuplesEqual = (
  left: ObjectStorageDestinationTuple,
  right: ObjectStorageDestinationTuple,
): boolean =>
  left.bucket === right.bucket && left.endpoint === right.endpoint && left.region === right.region;

export const mailDestinationTuple = (input: {
  provider: string;
  smtp?: {
    host?: string | null;
    port?: number | null;
    secure?: boolean | null;
    user?: string | null;
  } | null;
}): MailDestinationTuple => {
  if (input.provider === 'resend') {
    return { host: '', port: '', provider: 'resend', secure: '', user: '' };
  }
  return {
    host: trim(input.smtp?.host).toLowerCase(),
    port: String(input.smtp?.port ?? ''),
    provider: 'smtp',
    secure: input.smtp?.secure ? '1' : '0',
    user: trim(input.smtp?.user),
  };
};

export const mailTuplesEqual = (left: MailDestinationTuple, right: MailDestinationTuple): boolean =>
  left.provider === right.provider &&
  left.host === right.host &&
  left.port === right.port &&
  left.secure === right.secure &&
  left.user === right.user;

export const dbPreviewUrlExpireIn = (value: number | undefined): number =>
  value ?? INFRA_SETTINGS_DEFAULT_PREVIEW_URL_EXPIRE_IN;
