import { Buffer } from 'node:buffer';

import { PlatformSystemJobInvalidError } from './errors';

export const encodeCursor = (value: Record<string, string>): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

export const decodeCursor = (cursor: string | undefined): Record<string, unknown> | null => {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const parseJobCursor = (cursor: string | undefined) => {
  if (!cursor) return undefined;
  const value = decodeCursor(cursor);
  const createdAt = typeof value?.createdAt === 'string' ? new Date(value.createdAt) : null;
  if (
    !createdAt ||
    Number.isNaN(createdAt.getTime()) ||
    typeof value?.id !== 'string' ||
    !/^pjob_[0-9A-Za-z]{16}$/.test(value.id)
  ) {
    throw new PlatformSystemJobInvalidError();
  }
  return { createdAt, id: value.id };
};
