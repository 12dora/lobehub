import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

export interface InfraSaveError {
  /** CAS mismatch — the editor must offer a reload instead of a retry. */
  conflict: boolean;
  /** Form field the server named, when it named one. */
  field?: string;
  /** `admin` namespace key for the toast / inline message. */
  messageKey: string;
}

/** Contract leaf → the control that owns it, where the two names differ. */
const FIELD_ALIASES: Record<string, string> = {
  apiKey: 'resendApiKey',
  resend: 'resendApiKey',
  smtp: 'host',
};

/** Credentials — a rejection here always means "type it again", never "retry the same payload". */
const SECRET_FIELDS = new Set(['pass', 'resendApiKey', 'secretAccessKey']);

/**
 * Server paths are contract paths (`config.smtp.host`); the forms address their controls by the
 * leaf name (`host`). Strip the wrapper segments so a rejection lands on the right input.
 */
export const normalizeInfraFieldPath = (path: string): string | undefined => {
  const segments = path
    .split('.')
    .filter((segment) => segment.length > 0 && !/^\d+$/.test(segment));
  const leaf = segments.at(-1);
  const resolve = (name: string | undefined) =>
    name === undefined ? undefined : (FIELD_ALIASES[name] ?? name);

  if (!leaf || leaf === 'config' || leaf === 'action' || leaf === 'value') {
    // `secretAccessKey.action` / `smtp.pass.value` point at the secret control itself.
    const parent = segments.at(-2);
    return parent && parent !== 'config' ? resolve(parent) : undefined;
  }
  return resolve(leaf);
};

/**
 * Turn a failed write (or a rejected draft probe) into something the form can show next to a
 * control.
 *
 * There is deliberately no `zodError` branch: the lambda tRPC formatter does not expose Zod issues,
 * so schema violations are prevented client-side instead (`draft.ts` mirrors the contract schema).
 * What the server does name explicitly — a revision conflict, a refused credential reuse — is
 * mapped here.
 */
export const resolveInfraSaveError = (error: unknown): InfraSaveError => {
  const mapped = mapEnterpriseError(error);
  if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
    return { conflict: true, messageKey: 'systemGeneral.conflict.title' };
  }
  if (mapped?.code === 'PLATFORM_PERMISSION_DENIED' || mapped?.code === 'ADMIN_ACCESS_DENIED') {
    return { conflict: false, messageKey: 'systemGeneral.edit.saveForbidden' };
  }

  const details = (mapped?.details ?? {}) as Record<string, unknown>;
  const field =
    typeof details.field === 'string' ? normalizeInfraFieldPath(details.field) : undefined;

  if (field && SECRET_FIELDS.has(field)) {
    return { conflict: false, field, messageKey: 'systemGeneral.errors.secretReenterRequired' };
  }

  return {
    conflict: false,
    messageKey: field ? 'systemGeneral.edit.saveRejected' : 'systemGeneral.edit.saveFailed',
    ...(field ? { field } : {}),
  };
};
