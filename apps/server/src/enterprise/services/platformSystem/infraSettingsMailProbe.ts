import nodemailer from 'nodemailer';

import { createSafeOutboundHttpClient } from '../../security/outboundHttp';
import type { InfraEnvBag, ResolvedEmailConfig } from './infraDependencyConfig';
import { resolveEmailConfig } from './infraDependencyConfig';
import {
  InfraProbeError,
  isTimeoutError,
  isUnauthorizedError,
  PROBE_TIMEOUT_MS,
  withTimeout,
} from './infraProbes';
import type { InfraOutboundFetch, InfraSettingsServiceOptions } from './infraSettingsTypes';

const RESEND_DOMAINS_URL = 'https://api.resend.com/domains';

type EnvBag = InfraEnvBag;

export const defaultCreateMailTransport: NonNullable<
  InfraSettingsServiceOptions['createMailTransport']
> = (config) =>
  nodemailer.createTransport({
    auth: { pass: config.pass, user: config.user },
    connectionTimeout: PROBE_TIMEOUT_MS,
    greetingTimeout: PROBE_TIMEOUT_MS,
    host: config.host,
    port: config.port,
    secure: config.secure,
    socketTimeout: PROBE_TIMEOUT_MS,
  });

export const defaultOutboundFetch: InfraOutboundFetch = async (input, init) => {
  const outbound = createSafeOutboundHttpClient({
    mode:
      typeof input === 'string' && input.startsWith('https://api.resend.com')
        ? 'public-only'
        : 'allow-private',
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return outbound.fetch(input, {
    headers: init?.headers,
    method: init?.method,
    secretBearing: init?.secretBearing,
    timeoutMs: init?.timeoutMs ?? PROBE_TIMEOUT_MS,
  });
};

async function probeResendMail(
  resolved: Extract<ResolvedEmailConfig, { kind: 'resend' }>,
  outboundFetch: InfraOutboundFetch,
): Promise<void> {
  try {
    const response = await outboundFetch(RESEND_DOMAINS_URL, {
      headers: { Authorization: `Bearer ${resolved.apiKey}` },
      method: 'GET',
      secretBearing: true,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (response.status === 401 || response.status === 403) {
      throw new InfraProbeError('unauthorized');
    }
    if (!response.ok) throw new InfraProbeError('unreachable');
  } catch (error) {
    if (error instanceof InfraProbeError) throw error;
    if (isTimeoutError(error)) throw new InfraProbeError('timeout');
    throw new InfraProbeError('unreachable');
  }
}

async function probeSmtpMail(
  resolved: Extract<ResolvedEmailConfig, { kind: 'smtp' }>,
  createMailTransport: NonNullable<InfraSettingsServiceOptions['createMailTransport']>,
): Promise<void> {
  const transporter = createMailTransport(resolved);
  try {
    await withTimeout(async (signal) => {
      const verify = transporter.verify();
      const abort = new Promise<never>((_, reject) => {
        const onAbort = () => reject(new InfraProbeError('timeout'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([verify, abort]);
    });
  } catch (error) {
    if (error instanceof InfraProbeError) throw error;
    if (isTimeoutError(error)) throw new InfraProbeError('timeout');
    if (isUnauthorizedError(error)) throw new InfraProbeError('unauthorized');
    throw new InfraProbeError('unreachable');
  } finally {
    transporter.close?.();
  }
}

export async function probeMail(
  env: EnvBag,
  options: {
    createMailTransport: NonNullable<InfraSettingsServiceOptions['createMailTransport']>;
    outboundFetch: InfraOutboundFetch;
  },
): Promise<void> {
  const resolved = resolveEmailConfig(env);
  if (resolved.kind === 'unconfigured') throw new InfraProbeError('not_configured');
  if (resolved.kind === 'incomplete') throw new InfraProbeError('configuration_incomplete');

  if (resolved.kind === 'resend') {
    await probeResendMail(resolved, options.outboundFetch);
    return;
  }

  await probeSmtpMail(resolved, options.createMailTransport);
}
