import type { EnterpriseErrorBody } from '@/types/platform/errors';

/**
 * An error body as it arrives on the wire: same fields as {@link EnterpriseErrorBody}, but the
 * code has not been checked against the catalog yet. Presentation code reads bodies that carry
 * no code at all (older payloads ship `details` only), so the code stays optional here and the
 * catalog check belongs to whoever needs a validated one.
 */
export interface RawEnterpriseErrorBody extends Omit<EnterpriseErrorBody, 'code'> {
  code?: string;
}

const asBody = (value: unknown): RawEnterpriseErrorBody | undefined => {
  if (!value || typeof value !== 'object') return undefined;

  const { code, details, message } = value as {
    code?: unknown;
    details?: unknown;
    message?: unknown;
  };

  return {
    code: code === undefined || code === null ? undefined : String(code),
    details:
      details && typeof details === 'object'
        ? (details as EnterpriseErrorBody['details'])
        : undefined,
    message: typeof message === 'string' ? message : undefined,
  };
};

/**
 * Every candidate body on a tRPC / fetch rejection, in the order the transports layer them:
 * the formatter's `data.errorData`, a raw `TRPCError`'s `cause.data`, then the nested
 * `json.data.errorData` some clients hand back.
 *
 * The order is the point: a caller looking for a catalog code has to keep walking when the
 * first body carries something else, which is why the whole list is exposed rather than just
 * the head.
 */
export const readEnterpriseErrorBodies = (error: unknown): RawEnterpriseErrorBody[] => {
  if (!error || typeof error !== 'object') return [];

  const data = (error as { data?: { errorData?: unknown } }).data;
  const cause = (error as { cause?: { data?: unknown } }).cause;
  const json = (error as { json?: { data?: { errorData?: unknown } } }).json;

  return [asBody(data?.errorData), asBody(cause?.data), asBody(json?.data?.errorData)].filter(
    (body): body is RawEnterpriseErrorBody => Boolean(body),
  );
};

/**
 * The first structured body carried by an error, whatever its code.
 *
 * Core-safe on purpose: presentation surfaces (`src/routes/**`) may not import the enterprise
 * client layer, and this is the single walker they share with `mapEnterpriseError` so the two
 * cannot drift about where a server error keeps its code, message and details.
 */
export const readEnterpriseErrorBody = (error: unknown): RawEnterpriseErrorBody | undefined =>
  readEnterpriseErrorBodies(error)[0];
