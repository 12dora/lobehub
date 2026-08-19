import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

export const isNotFoundError = (error: unknown): boolean => {
  if (!error) return false;
  const mapped = mapEnterpriseError(error);
  if (mapped?.code === 'PLATFORM_NOT_FOUND') return true;
  const message = String((error as { message?: string })?.message ?? '');
  const dataCode = String(
    (error as { data?: { code?: string; errorData?: { code?: string } } })?.data?.errorData?.code ??
      (error as { data?: { code?: string } })?.data?.code ??
      '',
  );
  return /PLATFORM_NOT_FOUND/.test(message) || dataCode === 'PLATFORM_NOT_FOUND';
};
