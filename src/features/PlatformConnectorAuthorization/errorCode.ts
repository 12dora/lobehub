import { platformConnectorErrorCodeSchema } from '@/server/enterprise/contracts/platformConnectors';

export type ConnectorClientErrorCode =
  | 'PLATFORM_CONNECTOR_OAUTH_POPUP_BLOCKED'
  | 'PLATFORM_CONNECTOR_OAUTH_DISMISSED'
  | 'PLATFORM_CONNECTOR_OAUTH_TIMEOUT'
  | 'PLATFORM_CONNECTOR_OPERATION_FAILED'
  | 'PLATFORM_CONNECTOR_OPERATION_SUCCEEDED'
  | 'PLATFORM_CONNECTOR_DISCONNECTED'
  | 'PLATFORM_CONNECTOR_UNKNOWN_ERROR'
  | (typeof platformConnectorErrorCodeSchema)['_output'];

const extractErrorMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';

  const candidates = [
    (error as { message?: unknown }).message,
    (error as { data?: { code?: unknown } }).data?.code,
    (error as { data?: { errorData?: { code?: unknown } } }).data?.errorData?.code,
  ];
  return candidates.find((value): value is string => typeof value === 'string') ?? '';
};

export const resolveConnectorErrorCode = (error: unknown): ConnectorClientErrorCode => {
  const message = extractErrorMessage(error).trim();
  const parsed = platformConnectorErrorCodeSchema.safeParse(message);
  if (parsed.success) return parsed.data;
  if (message === 'PLATFORM_FEATURE_DISABLED') return 'PLATFORM_CONNECTOR_OPERATION_FAILED';
  return 'PLATFORM_CONNECTOR_UNKNOWN_ERROR';
};
